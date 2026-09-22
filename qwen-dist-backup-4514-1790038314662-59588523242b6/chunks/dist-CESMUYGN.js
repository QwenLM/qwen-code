// Force strict mode and setup for ESM
"use strict";
import {
  require_main
} from "./chunk-ZLBIFIMV.js";
import {
  ChannelBase,
  SessionRouter,
  getGlobalQwenDir,
  sanitizeLogText,
  sanitizePromptText,
  sanitizeSenderName,
  truncateCodePoints
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CQ35AJ4Z.js";
import {
  wrapper_default
} from "./chunk-J5TTWBZK.js";
import "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/channels/qqbot/dist/index.js
init_esbuild_shims();

// packages/channels/qqbot/dist/QQChannel.js
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, renameSync, unlinkSync } from "node:fs";
import { join as join2 } from "node:path";

// packages/channels/qqbot/dist/types.js
init_esbuild_shims();
var OpCode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
};
var Intent = {
  C2C_MESSAGE: 1 << 12,
  // C2C 消息
  GROUP_AT_MESSAGE: 1 << 25,
  // 群聊 @ 消息事件
  GROUP_MESSAGE: 1 << 26
  // 群聊全量消息事件 (GROUP_MESSAGE_CREATE)
};

// packages/channels/qqbot/dist/accounts.js
init_esbuild_shims();
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
function getCredsFilePath(safeName) {
  return join(getGlobalQwenDir(), "channels", `${safeName}-credentials.json`);
}
__name(getCredsFilePath, "getCredsFilePath");
function loadCredentials(credsFile) {
  if (!existsSync(credsFile))
    return null;
  try {
    const saved = JSON.parse(readFileSync(credsFile, "utf-8"));
    if (saved.appId && saved.appSecret) {
      return { appId: saved.appId, appSecret: saved.appSecret };
    }
    return null;
  } catch {
    return null;
  }
}
__name(loadCredentials, "loadCredentials");
function saveCredentials(credsFile, appId, appSecret) {
  const dir = join(getGlobalQwenDir(), "channels");
  mkdirSync(dir, { recursive: true });
  writeFileSync(credsFile, JSON.stringify({ appId, appSecret }), {
    mode: 384
  });
}
__name(saveCredentials, "saveCredentials");

// packages/channels/qqbot/dist/login.js
init_esbuild_shims();

// node_modules/@tencent-connect/qqbot-connector/dist/esm/index.js
init_esbuild_shims();

// node_modules/@tencent-connect/qqbot-connector/dist/esm/qr-connect.js
init_esbuild_shims();
var import_qrcode_terminal = __toESM(require_main(), 1);

// node_modules/@tencent-connect/qqbot-connector/dist/esm/qqbot-session.js
init_esbuild_shims();
import m from "node:crypto";
import _ from "node:https";
var E = { production: "q.qq.com", test: "test.q.qq.com" };
function u(t = "production") {
  return E[t];
}
__name(u, "u");
function l() {
  return m.randomBytes(32).toString("base64");
}
__name(l, "l");
var d;
(function(t) {
  t[t.NONE = 0] = "NONE", t[t.PENDING = 1] = "PENDING", t[t.COMPLETED = 2] = "COMPLETED", t[t.EXPIRED = 3] = "EXPIRED";
})(d || (d = {}));
function b(t, r) {
  const a = Buffer.from(r, "base64"), n = Buffer.from(t, "base64"), e = n.subarray(0, 12), i = n.subarray(n.length - 16), s = n.subarray(12, n.length - 16), o = m.createDecipheriv("aes-256-gcm", a, e);
  return o.setAuthTag(i), Buffer.concat([o.update(s), o.final()]).toString("utf8");
}
__name(b, "b");
function h(t, r, a) {
  return new Promise((n, e) => {
    const i = JSON.stringify(r), s = new URL(t), o = _.request({ hostname: s.hostname, path: s.pathname + s.search, method: "POST", timeout: a, headers: { "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(i) } }, (c) => {
      if (c.statusCode !== 200) {
        c.resume(), e(new Error(`HTTP ${c.statusCode} from ${t}`));
        return;
      }
      let f = "";
      c.on("data", (p2) => {
        f += p2;
      }), c.on("end", () => {
        try {
          n(JSON.parse(f));
        } catch (p2) {
          e(p2);
        }
      });
    });
    o.on("error", e), o.on("timeout", () => {
      o.destroy(), e(new Error(`timeout fetching ${t}`));
    }), o.end(i);
  });
}
__name(h, "h");
async function y(t = "production", r = 1e4) {
  const a = `https://${u(t)}/lite/create_bind_task`, n = l(), e = await h(a, { key: n }, r);
  if (e.retcode !== 0) throw new Error(e.msg ?? "create_bind_task failed");
  if (!e.data?.task_id) throw new Error("create_bind_task: missing task_id");
  return { taskId: e.data.task_id, key: n };
}
__name(y, "y");
async function g(t, r = "production", a = 1e4) {
  const n = `https://${u(r)}/lite/poll_bind_result`, e = await h(n, { task_id: t }, a);
  if (e.retcode !== 0) throw new Error(e.msg ?? "poll_bind_result failed");
  return { status: e.data?.status ?? d.NONE, botAppId: String(e.data?.bot_appid ?? ""), botEncryptSecret: e.data?.bot_encrypt_secret ?? "" };
}
__name(g, "g");
function w(t, r = "") {
  return `https://${u("production")}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(t)}&source=${encodeURIComponent(r)}&_wv=2`;
}
__name(w, "w");

// node_modules/@tencent-connect/qqbot-connector/dist/esm/qr-connect.js
var l2 = 2e3;
function F(o) {
  return new Promise((r) => {
    import_qrcode_terminal.default.generate(o, { small: true }, (t) => {
      r(t);
    });
  });
}
__name(F, "F");
function E2(o, r) {
  return new Promise((t, n) => {
    if (r?.aborted) {
      n(new DOMException("Aborted", "AbortError"));
      return;
    }
    const e = setTimeout(t, o);
    r?.addEventListener("abort", () => {
      clearTimeout(e), n(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
__name(E2, "E");
async function m2(o, r, t) {
  for (; !t?.aborted; ) {
    let n;
    try {
      n = await g(o);
    } catch {
      await E2(l2, t);
      continue;
    }
    if (n.status === d.COMPLETED) {
      const e = b(n.botEncryptSecret, r);
      return { outcome: "scanned", appId: n.botAppId, appSecret: e };
    }
    if (n.status === d.EXPIRED) return { outcome: "expired" };
    await E2(l2, t);
  }
  throw new DOMException("Aborted", "AbortError");
}
__name(m2, "m");
function p(o, r) {
  const t = new AbortController(), n = r?.signal ? AbortSignal.any([t.signal, r.signal]) : t.signal;
  return (async () => {
    const e = r?.displayQrCodeToConsole ?? true;
    for (; ; ) {
      if (n.aborted) throw new DOMException("Aborted", "AbortError");
      let a;
      try {
        a = await y();
      } catch (u2) {
        throw new Error(`\u83B7\u53D6\u7ED1\u5B9A\u4EFB\u52A1\u5931\u8D25: ${u2 instanceof Error ? u2.message : String(u2)}`, { cause: u2 });
      }
      const s = w(a.taskId, r?.source);
      if (e) {
        const u2 = await F(s);
        console.log(u2), console.log(`\u8BF7\u4F7F\u7528\u624B\u673A QQ \u626B\u63CF\u4E0A\u65B9\u4E8C\u7EF4\u7801\uFF0C\u5B8C\u6210\u673A\u5668\u4EBA\u7ED1\u5B9A\u3002
`);
      }
      o.onQrDisplayed?.(s);
      const c = await m2(a.taskId, a.key, n);
      if (c.outcome === "scanned") {
        o.onSuccess([{ appId: c.appId, appSecret: c.appSecret }]);
        return;
      }
      o.onQrExpired?.(), e && console.log(`\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u6B63\u5728\u5237\u65B0\u2026
`);
    }
  })().catch((e) => {
    if (e instanceof DOMException && e.name === "AbortError") {
      o.onFailure(new Error("\u5DF2\u53D6\u6D88"));
      return;
    }
    o.onFailure(e instanceof Error ? e : new Error(String(e)));
  }), () => t.abort();
}
__name(p, "p");
function C(o) {
  return new Promise((r, t) => {
    p({ onSuccess: r, onFailure: t }, { ...o, displayQrCodeToConsole: true });
  });
}
__name(C, "C");

// packages/channels/qqbot/dist/login.js
async function qrCodeLogin() {
  const results = await C();
  const creds = results[0];
  if (!creds?.appId || !creds?.appSecret) {
    throw new Error("QR login failed: no credentials returned");
  }
  return { appId: creds.appId, appSecret: creds.appSecret };
}
__name(qrCodeLogin, "qrCodeLogin");

// packages/channels/qqbot/dist/api.js
init_esbuild_shims();
var TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
var API_HOST = "https://api.sgroup.qq.com";
var SANDBOX_HOST = "https://sandbox.api.sgroup.qq.com";
var FETCH_TIMEOUT = 15e3;
async function fetchAccessToken(appId, appSecret) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {
    });
    process.stderr.write(`[QQ] Token request failed (HTTP ${resp.status})
`);
    throw new Error(`QQ Bot token request failed (HTTP ${resp.status})`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error("QQ Bot token response missing access_token");
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 7200
  };
}
__name(fetchAccessToken, "fetchAccessToken");
function validateGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:") {
      throw new Error(`QQ Bot gateway URL must use wss:// protocol, got: ${parsed.protocol}`);
    }
    if (!parsed.hostname.toLowerCase().endsWith(".qq.com")) {
      throw new Error(`QQ Bot gateway URL has unexpected hostname: ${parsed.hostname} (expected *.qq.com)`);
    }
    const clean = new URL(url);
    clean.username = "";
    clean.password = "";
    return clean.href;
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error("QQ Bot gateway URL is not a valid URL");
    }
    throw e;
  }
}
__name(validateGatewayUrl, "validateGatewayUrl");
async function fetchGatewayUrl(accessToken, sandbox) {
  const gw = sandbox ? `${SANDBOX_HOST}/gateway` : `${API_HOST}/gateway`;
  const resp = await fetch(gw, {
    headers: { Authorization: `QQBot ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {
    });
    throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
  }
  const data = await resp.json();
  if (!data["url"]) {
    throw new Error("QQ Bot gateway response missing WebSocket URL");
  }
  return validateGatewayUrl(data["url"]);
}
__name(fetchGatewayUrl, "fetchGatewayUrl");
function getApiBase(sandbox) {
  return sandbox ? SANDBOX_HOST : API_HOST;
}
__name(getApiBase, "getApiBase");
async function sendQQMessage(base, path, accessToken, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `QQBot ${accessToken}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });
}
__name(sendQQMessage, "sendQQMessage");

// packages/channels/qqbot/dist/QQChannel.js
var QQ_OPENID_RE = /^[A-F0-9]{32}$/i;
var DeliveryError = class extends Error {
  static {
    __name(this, "DeliveryError");
  }
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DeliveryError";
  }
};
function isValidChatId(id) {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
}
__name(isValidChatId, "isValidChatId");
var QQChannel = class _QQChannel extends ChannelBase {
  static {
    __name(this, "QQChannel");
  }
  ws = null;
  accessToken = "";
  tokenExpiresAt = 0;
  tokenRefreshTimer = null;
  heartbeatTimer = null;
  heartbeatInterval = 45e3;
  seq = 0;
  reconnectAttempts = 0;
  maxReconnectAttempts;
  /** QQ Bot session_id from READY, used for RESUME on reconnect. */
  sessionId = "";
  /** Whether this connection attempt should try RESUME first. */
  tryResume = false;
  qqConfig;
  /** Set when server sends RECONNECT opcode — close handler uses this to force reconnect. */
  serverRequestedReconnect = false;
  /** Pending connect promise reject — called when WebSocket closes before READY. */
  connectReject = null;
  /** Set to true when channel is disconnected — prevents orphaned connections. */
  disposed = false;
  /** Deduplicate inbound messages on reconnect replay (messageId → timestamp). */
  seenMessages = /* @__PURE__ */ new Map();
  /** Cleanup timer for seenMessages TTL eviction. */
  seenCleanupTimer = null;
  /** Timestamp of last received HEARTBEAT_ACK, for zombie-connection detection. */
  lastHeartbeatAck = 0;
  /** Debounce timer for saveQQState to avoid blocking event loop. */
  saveTimer = null;
  /** beforeExit hook to flush state when the event loop drains naturally. Does NOT fire for SIGKILL, OOM kills, or uncaughtException. */
  beforeExitHook = null;
  /** Timer for reconnectWithRetry fallback (unref'd so it doesn't block exit). */
  reconnectTimer = null;
  /** 30s READY timeout to prevent hanging on gateway without response. */
  readyTimeout = null;
  /** Guard against parallel reconnectWithRetry chains from stale close events. */
  isReconnecting = false;
  /** Track whether a chatId is a group or C2C for correct API routing. */
  chatTypeMap = /* @__PURE__ */ new Map();
  /** Track the latest user messageId per chatId for proper reply (msg_id). */
  replyMsgId = /* @__PURE__ */ new Map();
  replyContextByMessageId = /* @__PURE__ */ new Map();
  inboundReplyContext = new AsyncLocalStorage();
  /** msg_seq counter per user messageId, for multi-block streaming. */
  msgSeqMap = /* @__PURE__ */ new Map();
  /** Periodic cleanup timer for expired replyMsgId entries. */
  replyMsgIdCleanupTimer = null;
  /** 5-minute TTL for replyMsgId entries and seenMessages dedup. */
  static REPLY_MSG_ID_TTL_MS = 3e5;
  /** Idle-flush timeout: buffer is sent after this many ms of silence. */
  static IDLE_FLUSH_MS = 2e3;
  /** Max consecutive send failures before the stream is abandoned. */
  maxFlushRetries;
  /** Retry delay for subsequent attempts (backoff beyond first retry). */
  static IDLE_FLUSH_BACKOFF_MS = 4e3;
  /** Max buffer length before forcing an immediate flush. */
  static MAX_BUFFER_LENGTH = 4096;
  // ── Group / cron fields ────────────────────────────────────────
  /** Per-group bot OPENID map for multi-group support. */
  botOpenIdByGroup = /* @__PURE__ */ new Map();
  /** Dedup set for unexpected senderOpenId format warnings (key: `${chatId}:${senderOpenId}`). */
  warnedSenderOpenIds = /* @__PURE__ */ new Set();
  /** Guard: set to true after first READY + session restore completes. */
  _ready = false;
  /** Whether this process has never received READY (cold start). */
  coldStart = true;
  /** Track per-group active message permission. */
  groupActiveMsgEnabled = /* @__PURE__ */ new Map();
  /** Lazy cache for compiled keyword trigger RegExp patterns.
   * Built lazily on first access; never invalidated — keywordTriggers is not modified at runtime. */
  _keywordTriggerCache = null;
  /** Rate-limit timestamps for keyword non-match log entries (chatId → last log ms). */
  _lastKeywordNoMatchLog = /* @__PURE__ */ new Map();
  /** Accumulation buffer for cron/non-prompt textChunk events. */
  cronBuffer = /* @__PURE__ */ new Map();
  /** Named handler for permanent textChunk listener (cron/non-prompt). */
  _cronTextHandler = null;
  /** Gate: depth counter for cron-scheduled message flows. >0 means in-flow.
      Prevents phantom cronBuffer entries when textChunk fires during normal
      bridge.prompt() calls (ChannelBase has its own listener there).
      Using a counter instead of a boolean supports concurrent cron flows. */
  _inCronFlow = 0;
  cronTextHandlerAttached = false;
  /** Path to persisted QQ routing state: chatTypeMap, replyMsgId, msgSeqMap. */
  /**
   * Streaming state machine with per-session buffers.
   *
   * Three states for each session:
   *   active   — accumulating chunks in buffer (onResponseChunk extends timer)
   *   flushing — sendMessage() is in-flight (prevents parallel sends)
   *   idle     — waiting for next chunk (timer counting down to idleFlush)
   *
   * Transitions:
   *   active → flushing: idleFlush timer fires, or onToolCall cancels timer
   *   flushing → idle: send settles, idle timer restarts on retry
   *   any → done: onResponseComplete sends remaining content
   *
   * Guards:
   *   - flushingSessions prevents concurrent sends per session
   *   - pendingStreamDelete defers cleanup until in-flight send resolves
   *   - flushedSessions tracks already-sent sessions to skip final fullText
   */
  // ── Streaming state ───────────────────────────────────────────
  streamState = /* @__PURE__ */ new Map();
  flushingSessions = /* @__PURE__ */ new Set();
  pendingStreamDelete = /* @__PURE__ */ new Set();
  _reconnectId = 0;
  flushedSessions = /* @__PURE__ */ new Set();
  /**
   * Sessions with a prompt turn currently in flight, tracked via
   * onPromptStart/onPromptEnd.
   *
   * This is the discriminator the cron textChunk handler uses to tell
   * "prompt-response chunk" from "cron/non-prompt chunk". streamState
   * cannot serve that role (#6094): a residual entry from a finished
   * turn's unsettled flush silently blocks cron delivery. This set is
   * reliable because ChannelBase always brackets a prompt turn with
   * onPromptStart and onPromptEnd (onPromptEnd runs in the prompt path's
   * finally, even on error/cancel), independent of streaming config.
   */
  activePromptSessions = /* @__PURE__ */ new Set();
  qqStatePath;
  /**
   * Path to the global sessions.json managed by start.ts.
   * start.ts deletes it on shutdown, so we back it up.
   */
  globalSessionsPath;
  /** Backup of sessions.json so conversations survive daemon restarts. */
  sessionsBackupPath;
  constructor(name, config, bridge, options) {
    const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const stateDir = join2(getGlobalQwenDir(), "channels");
    mkdirSync2(stateDir, { recursive: true });
    const sessionsPath = join2(stateDir, `${safeName}-sessions.json`);
    const qqCfg = config;
    if ((qqCfg.groupAllPolicy === "keyword" || qqCfg.groupAllPolicy === "all") && config.sessionScope !== "single") {
      const originalScope = config.sessionScope;
      process.stderr.write(`[QQ:${name}] WARNING: groupAllPolicy is '${qqCfg.groupAllPolicy}' but sessionScope is '${originalScope}' (not 'single'). Forcing sessionScope to 'single' to ensure shared group context.
`);
      config = { ...config, sessionScope: "single" };
    }
    const router = options?.router ?? new SessionRouter(bridge, config.cwd, config.sessionScope, sessionsPath);
    super(name, config, bridge, {
      ...options,
      router,
      registerBridgeEvents: options?.registerBridgeEvents ?? !options?.router
    });
    this.qqConfig = config;
    this.maxReconnectAttempts = this.qqConfig.maxReconnectAttempts ?? 20;
    this.maxFlushRetries = this.qqConfig.maxFlushRetries ?? 3;
    const raw = this.qqConfig.bufferFlushLength;
    if (raw !== void 0 && (!Number.isInteger(raw) || raw <= 0 || raw > _QQChannel.MAX_BUFFER_LENGTH)) {
      process.stderr.write(`[QQ:${this.name}] WARNING: invalid bufferFlushLength=${raw}, using default ${_QQChannel.MAX_BUFFER_LENGTH}
`);
      this.qqConfig.bufferFlushLength = _QQChannel.MAX_BUFFER_LENGTH;
    }
    this.qqStatePath = join2(stateDir, `${safeName}-state.json`);
    this.globalSessionsPath = options?.router ? join2(stateDir, "sessions.json") : sessionsPath;
    this.sessionsBackupPath = join2(stateDir, `${safeName}-sessions-backup.json`);
    if (this.qqConfig["cron-msg-experimental"]) {
      this._cronTextHandler = (sid, t) => this.handleCronTextChunk(sid, t);
      this.attachCronHandler();
    }
  }
  handleCronTextChunk(sessionId, text) {
    const wasInCronFlow = this._inCronFlow > 0;
    setImmediate(() => {
      if (!this._ready) {
        process.stderr.write(`[QQ:${this.name}] Cron text chunk dropped (not ready): ${sanitizeLogText(text, 64)} for session ${sanitizeLogText(sessionId, 32)}
`);
        return;
      }
      if (!wasInCronFlow)
        return;
      if (this.activePromptSessions.has(sessionId))
        return;
      let entry = this.cronBuffer.get(sessionId);
      if (!entry) {
        entry = { buffer: "", timer: null };
        this.cronBuffer.set(sessionId, entry);
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.pendingRetry) {
          entry.buffer = entry.pendingRetry + entry.buffer;
          entry.pendingRetry = "";
        }
      }
      entry.buffer += text;
      const limit = this.qqConfig.bufferFlushLength ?? _QQChannel.MAX_BUFFER_LENGTH;
      const delay = entry.buffer.length >= limit ? 0 : 2e3;
      entry.timer = setTimeout(() => {
        const toFlush = entry.buffer;
        entry.buffer = "";
        entry.timer = null;
        if (toFlush) {
          const target = this.router.getTarget(sessionId);
          if (target) {
            this.sendMessageWithReplyContext(target.chatId, toFlush).then(() => {
              if (!entry.buffer && this.cronBuffer.get(sessionId) === entry)
                this.cronBuffer.delete(sessionId);
            }).catch((err) => {
              const code = err instanceof DeliveryError ? err.code : null;
              const codeStr = code ? ` (${code})` : "";
              process.stderr.write(`[QQ:${this.name}] Cron flush send error${codeStr}: ${sanitizeLogText(err instanceof Error ? err.message : String(err), 200)}
`);
              if (code === "RETRY_EXHAUSTED" || code === "ACTIVE_MSG_DISABLED" || code === "FALLBACK_FAILED") {
                this.cronBuffer.delete(sessionId);
                return;
              }
              entry.pendingRetry = toFlush;
              entry.retryCount = 1;
              if (entry.timer) {
                clearTimeout(entry.timer);
              }
              entry.timer = setTimeout(() => {
                entry.timer = null;
                entry.pendingRetry = "";
                if (this.cronBuffer.get(sessionId) !== entry) {
                  return;
                }
                const retryTarget = this.router.getTarget(sessionId);
                if (!retryTarget) {
                  process.stderr.write(`[QQ:${this.name}] Cron flush dropped after retry: no target for session ${sanitizeLogText(sessionId, 32)}
`);
                  this.cronBuffer.delete(sessionId);
                  return;
                }
                this.sendMessageWithReplyContext(retryTarget.chatId, toFlush).then(() => {
                  entry.pendingRetry = "";
                  if (!entry.buffer && this.cronBuffer.get(sessionId) === entry)
                    this.cronBuffer.delete(sessionId);
                }).catch((retryErr) => {
                  const retryCode = retryErr instanceof DeliveryError ? retryErr.code : null;
                  const retryCodeStr = retryCode ? ` (${retryCode})` : "";
                  process.stderr.write(`[QQ:${this.name}] Cron flush retry failed${retryCodeStr}: ${sanitizeLogText(retryErr instanceof Error ? retryErr.message : String(retryErr), 200)}
`);
                  entry.pendingRetry = "";
                  if (retryCode === "RETRY_EXHAUSTED" || retryCode === "ACTIVE_MSG_DISABLED" || retryCode === "FALLBACK_FAILED") {
                    if (!entry.buffer && this.cronBuffer.get(sessionId) === entry) {
                      this.cronBuffer.delete(sessionId);
                    }
                    return;
                  }
                  entry.retryCount = (entry.retryCount ?? 1) + 1;
                  if (entry.timer) {
                    clearTimeout(entry.timer);
                  }
                  entry.pendingRetry = toFlush;
                  entry.timer = setTimeout(() => {
                    entry.timer = null;
                    entry.pendingRetry = "";
                    if (this.cronBuffer.get(sessionId) !== entry) {
                      return;
                    }
                    const retryTarget2 = this.router.getTarget(sessionId);
                    if (!retryTarget2) {
                      process.stderr.write(`[QQ:${this.name}] Cron flush dropped after retry: no target for session ${sanitizeLogText(sessionId, 32)}
`);
                      this.cronBuffer.delete(sessionId);
                      return;
                    }
                    this.sendMessageWithReplyContext(retryTarget2.chatId, toFlush).then(() => {
                      entry.pendingRetry = "";
                      if (!entry.buffer && this.cronBuffer.get(sessionId) === entry)
                        this.cronBuffer.delete(sessionId);
                    }).catch((err2) => {
                      const code2 = err2 instanceof DeliveryError ? err2.code : null;
                      const code2Str = code2 ? ` (${code2})` : "";
                      process.stderr.write(`[QQ:${this.name}] Cron flush re-retry failed${code2Str}: ${sanitizeLogText(err2 instanceof Error ? err2.message : String(err2), 200)}, toFlush=${toFlush.length}, session=${sanitizeLogText(sessionId, 32)}
`);
                      entry.pendingRetry = "";
                      if (code2 === "RETRY_EXHAUSTED" || code2 === "ACTIVE_MSG_DISABLED" || code2 === "FALLBACK_FAILED") {
                        this.cronBuffer.delete(sessionId);
                        return;
                      }
                      process.stderr.write(`[QQ:${this.name}] Cron flush retries exhausted, dropped ${toFlush.length} chars for session ${sanitizeLogText(sessionId, 32)}
`);
                      this.cronBuffer.delete(sessionId);
                    });
                  }, entry.retryCount === 2 ? 1e4 : 5e3);
                  entry.timer.unref();
                });
              }, 5e3);
              entry.timer.unref();
            });
            return;
          }
        }
        process.stderr.write(`[QQ:${this.name}] Cron flush dropped: no target for session ${sanitizeLogText(sessionId, 32)}, lost ${toFlush.length} chars
`);
        this.cronBuffer.delete(sessionId);
      }, delay).unref();
    });
  }
  /**
   * Public gate for external cron/scheduler integration.
   * Wraps a cron message flow to activate `_inCronFlow` so that
   * `textChunk` events are captured into the cron accumulation buffer.
   * Uses a depth counter (not boolean) so concurrent cron flows
   * don't stomp each other's `_inCronFlow` state.
   * Always decrements `_inCronFlow` in a `finally` block.
   */
  async runCronFlow(fn) {
    this._inCronFlow++;
    try {
      await fn();
    } finally {
      if (this._inCronFlow > 0)
        this._inCronFlow--;
    }
  }
  /**
   * Override setBridge to re-attach the permanent `_cronTextHandler`
   * after bridge crash-recovery.
   */
  setBridge(bridge) {
    this.detachCronHandler();
    super.setBridge(bridge);
    this.attachCronHandler();
  }
  // ── ChannelBase interface ──────────────────────────────────────
  async connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._reconnectId++;
    this.disposed = false;
    this.reconnectAttempts = 0;
    this.serverRequestedReconnect = false;
    this.tryResume = false;
    if (!this.config.instructions) {
      const parts = [
        "## QQ Bot Channel",
        "",
        "\u4F60\u662F\u901A\u8FC7 QQ Bot \u4E0E\u7528\u6237\u5BF9\u8BDD\u7684 AI \u52A9\u624B\u3002",
        "\u652F\u6301 Markdown \u683C\u5F0F\uFF0C\u56DE\u590D\u81EA\u7136\u6D41\u7545\u5373\u53EF\u3002",
        "\u6D88\u606F\u524D\u7F00 [atMention=true] \u8868\u793A\u8BE5\u6D88\u606F @\u4E86\u4F60\uFF0C[atMention=false] \u8868\u793A\u672A @\u4F60\u3002",
        "\u4E0D\u60F3\u56DE\u590D\u65F6\u53EA\u8F93\u51FA <noreply> \u5373\u53EF\uFF0C\u6D88\u606F\u4E0D\u4F1A\u53D1\u51FA\u3002",
        "",
        "\u4EE5\u4E0B\u89C4\u5219\u4EC5\u9002\u7528\u4E8E\u7FA4\u804A\u6D88\u606F\u3002C2C \u79C1\u804A\u4E2D\u8BF7\u59CB\u7EC8\u6B63\u5E38\u56DE\u590D\u3002",
        "## \u7FA4\u804A\u5524\u9192\u4E0E\u9759\u9ED8\u89C4\u5219",
        "",
        "### \u5F53 [atMention=false] \u2014 \u672A @\u4F60",
        "\u7531\u4F60\u81EA\u4E3B\u5224\u65AD\u5F53\u524D\u804A\u5929\u6C1B\u56F4\u662F\u5426\u9002\u5408\u63D2\u5634\uFF1A",
        "- \u95F2\u804A/\u8C03\u4F83/\u73A9\u6897 \u2192 \u53EF\u4EE5\u63A5\u832C\uFF0C\u98CE\u8DA3\u5373\u53EF",
        "- \u4E25\u8083\u8BA8\u8BBA/\u4E8B\u52A1\u534F\u5546 \u2192 \u4FDD\u6301\u6C89\u9ED8",
        "- \u4E0D\u786E\u5B9A \u2192 \u6C89\u9ED8",
        "",
        "### \u5F53 [atMention=true] \u2014 @\u4E86\u4F60",
        "\u5148\u53BB\u6389 @\u6807\u7B7E\u548C\u4F60\u7684\u540D\u5B57\uFF0C\u5269\u4E0B\u7684\u5185\u5BB9\u662F\u5BF9\u4F60\u7684\u63D0\u95EE\u6216\u6307\u4EE4\u5417\uFF1F",
        "",
        "\u4EE5\u4E0B\u573A\u666F\u5373\u4F7F @\u4E86\u4F60\u4E5F\u5FC5\u987B\u6C89\u9ED8\uFF1A",
        '1. \u7EAF\u63D0\u53CA/\u9648\u8FF0 \u2014 "QwenCode \u597D\u50CF\u53D8\u806A\u660E\u4E86"',
        '2. \u8F6C\u8FF0/\u5F15\u7528 \u2014 "\u521A\u624D QwenCode \u7ED9\u7684\u65B9\u6848\u53EF\u4EE5"',
        '3. \u95F4\u63A5\u547C\u53EB \u2014 "@\u674E\u56DB \u4F60\u8BA9 QwenCode \u67E5\u4E0B"',
        '4. \u8C03\u4F83/\u8BD5\u63A2 \u2014 "\u8FD9\u4E8B QwenCode \u80AF\u5B9A\u4E0D\u77E5\u9053"',
        "",
        "### \u56DE\u590D\u51C6\u5219",
        '- \u88AB\u5524\u9192\u540E\u76F4\u63A5\u505A\u4E8B\uFF0C\u7981\u6B62"\u6211\u5728"\u7B49\u5360\u4F4D\u56DE\u590D',
        "- \u4E00\u6761\u6D88\u606F @\u591A\u4EBA\u65F6\uFF0C\u53EA\u6709\u660E\u786E\u6307\u6D3E\u7ED9\u4F60\u624D\u63A5",
        "- \u4E0D\u786E\u8BA4\u65F6\u5148\u6C89\u9ED8",
        "- \u5B8C\u6210\u5BF9\u8BDD\u540E\u7ACB\u523B\u56DE\u5F52\u9759\u9ED8"
      ];
      if (this.qqConfig.allowMention !== false) {
        parts.push("", "## @\u63D0\u53CA\u683C\u5F0F", "", "\u6D88\u606F\u5185\u5BB9\u4E2D\u7684 <@OPENID> \u6807\u7B7E\u4EE3\u8868\u7FA4\u6210\u5458\u7684 QQ \u6807\u8BC6\u3002", "\u6D88\u606F\u524D\u7F00 [\u6635\u79F0(OPENID)] \u4E2D\u7D27\u90BB ] \u4E4B\u524D\u7684\u62EC\u53F7\u5185\u662F\u8BE5\u53D1\u9001\u8005\u7684 32 \u4F4D\u5341\u516D\u8FDB\u5236 OPENID\uFF0C\u53EF\u7528 <@OPENID> \u56DE\u590D\u65F6 @\u4ED6\u3002", "\u6CE8\u610F\uFF1A\u7FA4\u6210\u5458\u6635\u79F0\u53EF\u80FD\u672C\u8EAB\u5305\u542B\u62EC\u53F7\u6216\u7279\u6B8A\u5B57\u7B26\uFF0C\u6635\u79F0\u4E2D\u7684\u62EC\u53F7\u5185\u5BB9\u4E0D\u662F OPENID\uFF0C\u8BF7\u52FF\u4F7F\u7528\u3002", "\u5F53\u5176\u4ED6\u7FA4\u6210\u5458 @\u4F60\uFF08\u673A\u5668\u4EBA\uFF09\u65F6\uFF0C\u6D88\u606F\u5185\u5BB9\u4E2D\u4F1A\u51FA\u73B0 <@\u4F60\u7684BotOPENID> \u6807\u7B7E\uFF0C\u8FD9\u4EE3\u8868\u8BE5\u6D88\u606F\u662F @\u7ED9\u4F60\u7684\u3002\u673A\u5668\u4EBA\u81EA\u5DF1\u7684 OPENID \u5C06\u5728\u8FDE\u63A5\u5EFA\u7ACB\u540E\u544A\u77E5\u3002", "\u4F60\u53EF\u4EE5\u5728\u56DE\u590D\u4E2D\u4F7F\u7528 <@OPENID> \u683C\u5F0F\u6765 @\u63D0\u53CA\u7279\u5B9A\u7684\u7FA4\u6210\u5458\u3002", '\u4F8B\u5982\uFF1A\u56DE\u590D "<@ABC123DEF456> \u4F60\u597D" \u4F1A\u5728\u7FA4\u91CC @\u8BE5\u6210\u5458\u3002');
      }
      this.config.instructions = parts.join("\n");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.fetchToken();
        await this.connectGateway();
        if (this.beforeExitHook) {
          process.off("beforeExit", this.beforeExitHook);
        }
        this.beforeExitHook = () => this.flushQQState();
        process.on("beforeExit", this.beforeExitHook);
        this.startReplyMsgIdCleanup();
        return;
      } catch (e) {
        if (attempt < 2) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[QQ:${this.name}] Connect attempt ${attempt + 1} failed: ${sanitizeLogText(msg, 200)}, retrying...
`);
          await this.sleep(2e3);
        } else {
          throw new Error(sanitizeLogText(e instanceof Error ? e.message : String(e), 200), { cause: e });
        }
      }
    }
  }
  async handleInbound(envelope) {
    const context = envelope.messageId ? this.replyContextByMessageId.get(envelope.messageId) : void 0;
    if (!context || context.chatId !== envelope.chatId) {
      await super.handleInbound(envelope);
      return;
    }
    await this.inboundReplyContext.run(context, () => super.handleInbound(envelope));
  }
  async sendMessage(chatId, text) {
    const inboundContext = this.inboundReplyContext.getStore();
    const latest = this.replyMsgId.get(chatId);
    const replyContext = inboundContext?.chatId === chatId ? inboundContext : latest ? { chatId, ...latest } : void 0;
    await this.sendMessageWithReplyContext(chatId, text, replyContext);
  }
  async sendThreadMessage(chatId, _threadId, text, sourceLabel) {
    const inboundContext = this.inboundReplyContext.getStore();
    const latest = this.replyMsgId.get(chatId);
    const replyContext = inboundContext?.chatId === chatId ? inboundContext : latest ? { chatId, ...latest } : void 0;
    await this.sendMessageWithReplyContext(chatId, text, replyContext, sourceLabel);
  }
  async sendResponseMessage(chatId, text, sessionId, sourceLabel) {
    const messageId = this.getResponseMessageId(sessionId);
    const replyContext = messageId ? this.replyContextByMessageId.get(messageId) : void 0;
    await this.sendMessageWithReplyContext(chatId, text, replyContext, sourceLabel ?? this.getResponseSourceLabel(sessionId));
  }
  async sendMessageWithReplyContext(chatId, text, replyContext, sourceLabel) {
    if (text.trim() === "<noreply>") {
      process.stderr.write(`[QQ:${this.name}] <noreply> skipped for ${sanitizeLogText(chatId, 64)}
`);
      return;
    }
    const outgoingText = this.formatMarkdownAttributedText(text, sourceLabel);
    const plainOutgoingText = this.formatAttributedText(text, sourceLabel);
    const route = await this.resolveRoute(chatId);
    if (!route)
      return;
    const entry = replyContext?.chatId === chatId ? replyContext : void 0;
    const msgId = entry && Date.now() - entry.timestamp < _QQChannel.REPLY_MSG_ID_TTL_MS ? entry.msgId : void 0;
    if (entry && !msgId) {
      process.stderr.write(`[QQ:${this.name}] replyMsgId entry expired for ${sanitizeLogText(chatId, 64)}, reply context expired, sending without msg_id
`);
      this.deleteReplyContext(entry);
      this.saveQQState();
    }
    if (!msgId && this.groupActiveMsgEnabled.get(chatId) === false) {
      const cronCtx = this._inCronFlow ? " (cron flow discarded)" : "";
      process.stderr.write(`[QQ:${this.name}] sendMessage blocked: active messages disabled for ${sanitizeLogText(chatId, 64)}${cronCtx}
`);
      throw new DeliveryError("ACTIVE_MSG_DISABLED", `Active messages disabled for ${sanitizeLogText(chatId, 64)}`);
    }
    let nextSeq = 0;
    let rollbackApplied = false;
    try {
      const passiveBody = {
        msg_type: 2,
        markdown: { content: outgoingText }
      };
      nextSeq = msgId ? (this.msgSeqMap.get(msgId) ?? 0) + 1 : 0;
      if (msgId) {
        this.msgSeqMap.set(msgId, nextSeq);
        passiveBody["msg_id"] = msgId;
        passiveBody["msg_seq"] = nextSeq;
      }
      const resp = await sendQQMessage(route.base, route.path, this.accessToken, passiveBody);
      if (!resp.ok) {
        const errBody = sanitizeLogText(await resp.text().catch(() => ""), 200);
        if (resp.status !== 429) {
          process.stderr.write(`[QQ:${this.name}] Send failed (HTTP ${resp.status}: ${errBody})

`);
        }
        if (resp.status === 429) {
          process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on markdown attempt for ${sanitizeLogText(chatId, 64)}
`);
          if (msgId) {
            this.msgSeqMap.set(msgId, nextSeq - 1);
            this.saveQQState();
          }
          throw new DeliveryError("RATE_LIMITED", `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`);
        }
        if (msgId) {
          this.msgSeqMap.set(msgId, nextSeq - 1);
          rollbackApplied = true;
          if (this.groupActiveMsgEnabled.get(chatId) === false) {
            process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: active messages disabled for ${sanitizeLogText(chatId, 64)}, cannot retry
`);
            this.saveQQState();
            throw new DeliveryError("ACTIVE_MSG_DISABLED", `Active messages disabled for ${sanitizeLogText(chatId, 64)}`);
          }
          const activeMdBody = {
            msg_type: 2,
            markdown: { content: outgoingText }
          };
          const activeMdResp = await sendQQMessage(route.base, route.path, this.accessToken, activeMdBody);
          if (activeMdResp.ok) {
            process.stderr.write(`[QQ:${this.name}] Active markdown retry succeeded for ${sanitizeLogText(chatId, 64)}
`);
            this.saveQQState();
            await activeMdResp.text().catch(() => "");
            return;
          }
          const mdErrBody = sanitizeLogText(await activeMdResp.text().catch(() => ""), 200);
          if (activeMdResp.status === 429) {
            process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on active markdown retry for ${sanitizeLogText(chatId, 64)}
`);
            this.saveQQState();
            throw new DeliveryError("RATE_LIMITED", `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`);
          }
          process.stderr.write(`[QQ:${this.name}] Active markdown retry failed (HTTP ${activeMdResp.status}: ${mdErrBody}) for ${sanitizeLogText(chatId, 64)}
`);
          const activeTextBody = {
            content: plainOutgoingText,
            msg_type: 0
          };
          const activeTextResp = await sendQQMessage(route.base, route.path, this.accessToken, activeTextBody);
          if (activeTextResp.ok) {
            process.stderr.write(`[QQ:${this.name}] Active text fallback succeeded for ${sanitizeLogText(chatId, 64)}
`);
            this.saveQQState();
            await activeTextResp.text().catch(() => "");
            return;
          }
          const textErrBody = sanitizeLogText(await activeTextResp.text().catch(() => ""), 200);
          if (activeTextResp.status === 429) {
            process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on active text fallback for ${sanitizeLogText(chatId, 64)}
`);
            this.saveQQState();
            throw new DeliveryError("RATE_LIMITED", `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`);
          }
          process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: active text fallback failed (HTTP ${activeTextResp.status}: ${textErrBody}) for ${sanitizeLogText(chatId, 64)}
`);
          this.saveQQState();
          throw new DeliveryError("FALLBACK_FAILED", `All delivery attempts exhausted for ${sanitizeLogText(chatId, 64)}`);
        }
        const plainBody = {
          content: plainOutgoingText,
          msg_type: 0
        };
        const fallbackRes = await sendQQMessage(route.base, route.path, this.accessToken, plainBody);
        if (!fallbackRes.ok) {
          const fbErrBody = await fallbackRes.text().catch(() => "");
          if (fallbackRes.status === 429) {
            process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: rate-limited (429) on plain-text fallback for ${sanitizeLogText(chatId, 64)}
`);
            throw new DeliveryError("RATE_LIMITED", `Message blocked by rate limit for ${sanitizeLogText(chatId, 64)}`);
          }
          process.stderr.write(`[QQ:${this.name}] MESSAGE DROPPED: plain-text fallback failed (HTTP ${fallbackRes.status}: ${sanitizeLogText(fbErrBody, 200)}) for ${sanitizeLogText(chatId, 64)}
`);
          throw new DeliveryError("FALLBACK_FAILED", `Plain-text fallback delivery failed for ${sanitizeLogText(chatId, 64)}`);
        }
        process.stderr.write(`[QQ:${this.name}] Plain-text fallback succeeded for ${sanitizeLogText(chatId, 64)}
`);
        await fallbackRes.text().catch(() => "");
        return;
      }
      await resp.text().catch(() => "");
      if (msgId)
        this.saveQQState();
    } catch (e) {
      if (msgId && !rollbackApplied) {
        this.msgSeqMap.set(msgId, nextSeq - 1);
      }
      if (msgId)
        this.saveQQState();
      if (!(e instanceof DeliveryError)) {
        process.stderr.write(`[QQ:${this.name}] Send error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`);
      }
      throw e;
    }
  }
  /**
   * Resolve API routing: handles disposed check, token refresh, chatId validation,
   * sandbox detection, and C2C/group path selection. Returns null if any guard fails.
   */
  async resolveRoute(chatId) {
    if (this.disposed) {
      process.stderr.write(`[QQ:${this.name}] resolveRoute: channel disposed, dropping message to ${sanitizeLogText(chatId, 64)}
`);
      return null;
    }
    if (Date.now() >= this.tokenExpiresAt) {
      try {
        await this.fetchToken();
      } catch (_e) {
        process.stderr.write(`[QQ:${this.name}] resolveRoute: token refresh failed (${sanitizeLogText(_e instanceof Error ? _e.message : String(_e), 120)}), dropping message to ${sanitizeLogText(chatId, 64)}
`);
        return null;
      }
    }
    if (!this.accessToken) {
      process.stderr.write(`[QQ:${this.name}] resolveRoute: accessToken is empty after fetchToken
`);
      return null;
    }
    if (!isValidChatId(chatId)) {
      process.stderr.write(`[QQ:${this.name}] resolveRoute: invalid chatId rejected (length=${chatId.length})
`);
      return null;
    }
    const base = getApiBase(Boolean(this.qqConfig.sandbox));
    const routeType = this.chatTypeMap.get(chatId) || this.qqConfig.chatTypes?.[chatId];
    if (routeType !== "group" && routeType !== "c2c") {
      process.stderr.write(`[QQ:${this.name}] resolveRoute: no chat type for ${sanitizeLogText(chatId, 64)}, dropping message
`);
      return null;
    }
    const path = routeType === "group" ? `/v2/groups/${chatId}/messages` : `/v2/users/${chatId}/messages`;
    return { base, path };
  }
  disconnect() {
    this._reconnectId++;
    this.disposed = true;
    this._ready = false;
    this.stopHeartbeat();
    this.stopTokenRefresh();
    this.stopReplyMsgIdCleanup();
    if (this.seenCleanupTimer) {
      clearInterval(this.seenCleanupTimer);
      this.seenCleanupTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.beforeExitHook) {
      process.off("beforeExit", this.beforeExitHook);
      this.beforeExitHook = null;
    }
    let droppedCount = 0;
    for (const [, entry] of this.cronBuffer) {
      if (entry.timer)
        clearTimeout(entry.timer);
      if (entry.buffer)
        droppedCount++;
    }
    if (droppedCount > 0) {
      process.stderr.write(`[QQ:${this.name}] Disconnect: discarding ${droppedCount} buffered cron message(s)
`);
    }
    this.cronBuffer.clear();
    this._lastKeywordNoMatchLog.clear();
    this.flushQQState();
    this.backupGlobalSessions();
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    if (this.ws) {
      this.ws.close(1e3);
      this.ws = null;
    }
    if (this.connectReject) {
      this.connectReject(new Error("Channel disconnected"));
      this.connectReject = null;
    }
    this.detachCronHandler();
    this.chatTypeMap.clear();
    this.replyMsgId.clear();
    this.replyContextByMessageId.clear();
    this.msgSeqMap.clear();
    this.botOpenIdByGroup.clear();
    this.warnedSenderOpenIds.clear();
    this.groupActiveMsgEnabled.clear();
    this.seenMessages.clear();
    this.coldStart = true;
    if (this._inCronFlow > 0) {
      process.stderr.write(`[QQ:${this.name}] resetRoutingState: orphaned cron flow (depth=${this._inCronFlow}) during disconnect
`);
    }
    this._inCronFlow = 0;
    for (const [, state] of this.streamState) {
      if (state.timer)
        clearTimeout(state.timer);
    }
    this.streamState.clear();
    this.flushingSessions.clear();
    this.pendingStreamDelete.clear();
    this.flushedSessions.clear();
    this.activePromptSessions.clear();
  }
  /**
   * QQ Bot API V2 does not provide a typing indicator endpoint, but these
   * hooks still maintain activePromptSessions — the cron textChunk
   * discriminator (see activePromptSessions). ChannelBase always pairs the
   * two calls per prompt turn (onPromptEnd runs in the prompt path's
   * finally, even on error/cancel).
   */
  onPromptStart(_chatId, sessionId, _messageId) {
    this.activePromptSessions.add(sessionId);
  }
  onPromptEnd(_chatId, sessionId, _messageId) {
    this.activePromptSessions.delete(sessionId);
  }
  // ── Streaming (idle-flush with per-session buffers) ────────────
  onResponseChunk(chatId, chunk, sessionId, segment) {
    let state = this.streamState.get(sessionId);
    if (!state) {
      const messageId = segment?.messageId ?? this.getResponseMessageId(sessionId);
      const replyContext = messageId ? this.replyContextByMessageId.get(messageId) : void 0;
      state = {
        chatId,
        buffer: chunk,
        timer: null,
        retryCount: 0,
        ...replyContext ? { replyContext } : {},
        ...segment?.sourceLabel ? { sourceLabel: segment.sourceLabel } : {}
      };
      this.streamState.set(sessionId, state);
    } else {
      state.sourceLabel ??= segment?.sourceLabel;
      state.buffer += chunk;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    if (state.buffer.length >= this.streamBufferLimit(state)) {
      const buf = state.buffer;
      state.buffer = "";
      if (this.flushingSessions.has(sessionId)) {
        state.buffer = buf + (state.buffer || "");
        state.timer = setTimeout(() => {
          this.idleFlush(sessionId, this._reconnectId);
        }, _QQChannel.IDLE_FLUSH_MS);
        state.timer.unref?.();
        return;
      }
      this.flushAndTrack(sessionId, buf, state, "idleFlush");
      return;
    }
    const reconnectId = this._reconnectId;
    state.timer = setTimeout(() => {
      this.idleFlush(sessionId, reconnectId);
    }, _QQChannel.IDLE_FLUSH_MS);
    state.timer.unref?.();
  }
  idleFlush(sessionId, reconnectId) {
    if (this._reconnectId !== reconnectId) {
      process.stderr.write(`[QQ:${this.name}] idleFlush discarded (reconnect) session=${sanitizeLogText(sessionId, 32)}
`);
      return;
    }
    const state = this.streamState.get(sessionId);
    if (!state || !state.buffer)
      return;
    if (this.flushingSessions.has(sessionId)) {
      if (!state.timer) {
        const retryReconnectId = this._reconnectId;
        state.timer = setTimeout(() => {
          this.idleFlush(sessionId, retryReconnectId);
        }, _QQChannel.IDLE_FLUSH_MS);
        state.timer.unref?.();
      }
      return;
    }
    const buffer = state.buffer;
    state.buffer = "";
    state.timer = null;
    this.flushAndTrack(sessionId, buffer, state, "idleFlush");
  }
  /**
   * Shared send-and-track helper used by idleFlush and onToolCall.
   * Encapsulates .then() (cleanup on success) and .catch() (retry/re-buffer
   * on failure) logic to eliminate duplication.
   */
  flushAndTrack(sessionId, buffer, state, logLabel) {
    this.flushingSessions.add(sessionId);
    this.sendMessageWithReplyContext(state.chatId, buffer, state.replyContext, state.sourceLabel).then(() => {
      const current = this.streamState.get(sessionId);
      if (current !== state)
        return;
      current.retryCount = 0;
      this.flushedSessions.add(sessionId);
      if (this.pendingStreamDelete.has(sessionId)) {
        this.pendingStreamDelete.delete(sessionId);
        const s2 = this.streamState.get(sessionId);
        if (s2 === state && s2.buffer) {
          this.idleFlush(sessionId, this._reconnectId);
        }
      }
      const s = this.streamState.get(sessionId);
      if (s === state && !s.buffer) {
        this.streamState.delete(sessionId);
      }
    }).catch((e) => {
      if (e instanceof DeliveryError && (e.code === "RETRY_EXHAUSTED" || e.code === "ACTIVE_MSG_DISABLED" || e.code === "FALLBACK_FAILED")) {
        process.stderr.write(`[QQ:${this.name}] ${logLabel} delivery failed (${e.code}): ${sanitizeLogText(e.message, 200)}, dropping ${buffer.length} chars
`);
        const current = this.streamState.get(sessionId);
        if (current === state) {
          this.streamState.delete(sessionId);
        }
        if (this.pendingStreamDelete.has(sessionId)) {
          this.pendingStreamDelete.delete(sessionId);
          this.flushedSessions.delete(sessionId);
        }
        return;
      }
      process.stderr.write(`[QQ:${this.name}] ${logLabel} send failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`);
      if (this.pendingStreamDelete.has(sessionId)) {
        this.pendingStreamDelete.delete(sessionId);
        const current = this.streamState.get(sessionId);
        if (current === state) {
          current.buffer = buffer;
          current.retryCount++;
          if (this.maxFlushRetries <= 0 || current.retryCount < this.maxFlushRetries) {
            const reconnectId = this._reconnectId;
            const delay = current.retryCount > 1 ? _QQChannel.IDLE_FLUSH_BACKOFF_MS : _QQChannel.IDLE_FLUSH_MS;
            current.timer = setTimeout(() => {
              this.idleFlush(sessionId, reconnectId);
            }, delay);
            current.timer.unref?.();
          } else {
            this.streamState.delete(sessionId);
            this.flushedSessions.delete(sessionId);
            process.stderr.write(`[QQ:${this.name}] ${logLabel} retries exhausted for ${sanitizeLogText(sessionId, 64)}
`);
          }
        }
      } else {
        const current = this.streamState.get(sessionId);
        if (current === state) {
          current.buffer = buffer + (current.buffer || "");
          if (current.buffer.length >= this.streamBufferLimit(current)) {
            current.retryCount++;
            if (this.maxFlushRetries > 0 && current.retryCount >= this.maxFlushRetries) {
              this.streamState.delete(sessionId);
              this.flushedSessions.delete(sessionId);
              process.stderr.write(`[QQ:${this.name}] ${logLabel} retries exhausted (buffer exceeds limit) for ${sanitizeLogText(sessionId, 64)}
`);
            } else {
              this.idleFlush(sessionId, this._reconnectId);
            }
          } else {
            current.retryCount++;
            if (this.maxFlushRetries <= 0 || current.retryCount < this.maxFlushRetries) {
              if (!current.timer) {
                const reconnectId = this._reconnectId;
                const delay = current.retryCount > 1 ? _QQChannel.IDLE_FLUSH_BACKOFF_MS : _QQChannel.IDLE_FLUSH_MS;
                current.timer = setTimeout(() => {
                  this.idleFlush(sessionId, reconnectId);
                }, delay);
                current.timer.unref?.();
              }
            } else {
              this.streamState.delete(sessionId);
              this.flushedSessions.delete(sessionId);
              process.stderr.write(`[QQ:${this.name}] ${logLabel} retries exhausted for ${sanitizeLogText(sessionId, 64)}
`);
            }
          }
        }
      }
    }).finally(() => {
      const current = this.streamState.get(sessionId);
      if (!current || current === state) {
        this.flushingSessions.delete(sessionId);
      }
    });
  }
  onToolCall(_chatId, event) {
    const state = this.streamState.get(event.sessionId);
    if (!state || !state.buffer)
      return;
    if (this.flushingSessions.has(event.sessionId))
      return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const buffer = state.buffer;
    state.buffer = "";
    this.flushAndTrack(event.sessionId, buffer, state, "toolCallFlush");
  }
  onResponseBoundary(_chatId, sessionId) {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
  }
  async onResponseComplete(chatId, fullText, sessionId, segment) {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state && this.flushingSessions.has(sessionId)) {
      this.pendingStreamDelete.add(sessionId);
      process.stderr.write(`[QQ:${this.name}] onResponseComplete deferred (flush in-flight) session=${sanitizeLogText(sessionId, 32)}
`);
      return;
    }
    const wasFlushed = this.flushedSessions.has(sessionId);
    const remaining = state?.buffer ?? (wasFlushed ? "" : fullText);
    const sourceLabel = segment?.sourceLabel ?? state?.sourceLabel ?? this.getResponseSourceLabel(sessionId);
    this.streamState.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    if (remaining) {
      await this.sendResponseMessage(chatId, remaining, sessionId, sourceLabel);
    }
  }
  streamBufferLimit(state) {
    const configured = this.qqConfig.bufferFlushLength ?? _QQChannel.MAX_BUFFER_LENGTH;
    if (!state.sourceLabel)
      return configured;
    const attributed = this.formatMarkdownAttributedText("x", state.sourceLabel);
    return Math.max(1, configured - (attributed.length - 1));
  }
  onSessionDied(sessionId) {
    const state = this.streamState.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.streamState.delete(sessionId);
    this.flushingSessions.delete(sessionId);
    this.pendingStreamDelete.delete(sessionId);
    this.flushedSessions.delete(sessionId);
    this.activePromptSessions.delete(sessionId);
    super.onSessionDied(sessionId);
  }
  // ── State Persistence (cross-server context continuation) ──────
  serializeQQState() {
    return JSON.stringify({
      chatTypeMap: Array.from(this.chatTypeMap.entries()),
      replyMsgId: Array.from(this.replyMsgId.entries()),
      msgSeqMap: Array.from(this.msgSeqMap.entries()),
      groupActiveMsgEnabled: Array.from(this.groupActiveMsgEnabled.entries()),
      botOpenIdByGroup: Array.from(this.botOpenIdByGroup.entries())
    });
  }
  /** Debounced state persistence with atomic write. */
  saveQQState() {
    if (this.disposed)
      return;
    if (this.saveTimer)
      clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.disposed)
        return;
      const tmpPath = this.qqStatePath + ".tmp";
      try {
        writeFileSync2(tmpPath, this.serializeQQState(), { mode: 384 });
        renameSync(tmpPath, this.qqStatePath);
      } catch (e) {
        try {
          unlinkSync(tmpPath);
        } catch {
        }
        process.stderr.write(`[QQ:${this.name}] saveQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}

`);
      }
    }, 500);
    this.saveTimer.unref();
  }
  /**
   * Attach the permanent textChunk handler for cron/non-prompt messages
   * to the current bridge. No-op if already attached or if cron is disabled.
   */
  attachCronHandler() {
    if (this.qqConfig["cron-msg-experimental"] && this._cronTextHandler && !this.cronTextHandlerAttached) {
      this.bridge.on?.("textChunk", this._cronTextHandler);
      this.cronTextHandlerAttached = true;
    }
  }
  _checkGroupAllPolicyRequireMention() {
    const policy = this.qqConfig.groupAllPolicy;
    if (policy !== "keyword" && policy !== "all")
      return;
    const groups = this.config.groups;
    const anyFalse = groups && Object.values(groups).some((g2) => g2.requireMention === false);
    if (!anyFalse) {
      process.stderr.write(`[QQ:${this.name}] WARNING: groupAllPolicy is '${policy}' but requireMention is true (default). Non-@-bot messages passing keyword/all policy will be silently dropped by GroupGate. Set 'groups': { '*': { 'requireMention': false } } in channel config.
`);
    }
  }
  /**
   * Detach the permanent textChunk handler from the current bridge.
   * No-op if not attached or if cron is disabled.
   */
  detachCronHandler() {
    if (this.qqConfig["cron-msg-experimental"] && this._cronTextHandler && this.cronTextHandlerAttached) {
      this.bridge.off?.("textChunk", this._cronTextHandler);
      this.cronTextHandlerAttached = false;
    }
  }
  /** Flush pending state writes immediately (called on disconnect). */
  flushQQState() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmpPath = this.qqStatePath + ".tmp";
    try {
      writeFileSync2(tmpPath, this.serializeQQState(), { mode: 384 });
      renameSync(tmpPath, this.qqStatePath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
      }
      process.stderr.write(`[QQ:${this.name}] flushQQState write failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}

`);
    }
  }
  /**
   * Restore QQ routing state from disk.
   *
   * Validates all restored state extensively — type checks, length bounds,
   * and sanity filters — so a corrupted file produces clean empty maps
   * rather than propagating invalid data.
   */
  restoreQQState() {
    try {
      if (!existsSync2(this.qqStatePath))
        return false;
      const raw = JSON.parse(readFileSync2(this.qqStatePath, "utf-8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        process.stderr.write(`[QQ:${this.name}] Invalid QQ state file (not an object), ignoring
`);
        return false;
      }
      if (raw.chatTypeMap) {
        const arr = raw.chatTypeMap;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.chatTypeMap = new Map(Array.isArray(arr) ? arr.filter(([k, v]) => typeof k === "string" && k.length <= 256 && (v === "c2c" || v === "group")) : []);
        if (this.chatTypeMap.size < totalRaw) {
          process.stderr.write(`[QQ:${this.name}] restoreQQState: accepted ${this.chatTypeMap.size} chatTypeMap entries (rejected ${totalRaw - this.chatTypeMap.size})
`);
        }
      }
      if (raw.replyMsgId) {
        const arr = raw.replyMsgId;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.replyMsgId = new Map(Array.isArray(arr) ? arr.filter(([k]) => typeof k === "string" && k.length <= 256).filter(([, v]) => {
          if (typeof v === "string" && v.length <= 128)
            return true;
          if (v === null || typeof v !== "object")
            return false;
          const o = v;
          return typeof o["msgId"] === "string" && o["msgId"].length <= 128 && typeof o["timestamp"] === "number" && Number.isFinite(o["timestamp"]) && o["timestamp"] >= Date.now() - _QQChannel.REPLY_MSG_ID_TTL_MS && o["timestamp"] <= Date.now() + _QQChannel.REPLY_MSG_ID_TTL_MS;
        }).map(([k, v]) => [
          k,
          typeof v === "string" ? { msgId: v, timestamp: Date.now() } : v
        ]) : []);
        if (this.replyMsgId.size < totalRaw) {
          process.stderr.write(`[QQ:${this.name}] restoreQQState: accepted ${this.replyMsgId.size} replyMsgId entries (rejected ${totalRaw - this.replyMsgId.size})
`);
        }
      }
      this.replyContextByMessageId = new Map(Array.from(this.replyMsgId, ([chatId, entry]) => [
        entry.msgId,
        { chatId, ...entry }
      ]));
      if (raw.msgSeqMap) {
        const arr = raw.msgSeqMap;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.msgSeqMap = new Map(Array.isArray(arr) ? arr.filter(([k, v]) => typeof k === "string" && k.length <= 256 && typeof v === "number" && Number.isSafeInteger(v) && v >= 0) : []);
        if (this.msgSeqMap.size < totalRaw) {
          process.stderr.write(`[QQ:${this.name}] restoreQQState: accepted ${this.msgSeqMap.size} msgSeqMap entries (rejected ${totalRaw - this.msgSeqMap.size})
`);
        }
      }
      for (const msgId of this.msgSeqMap.keys()) {
        if (!this.replyContextByMessageId.has(msgId)) {
          this.msgSeqMap.delete(msgId);
        }
      }
      if (raw.groupActiveMsgEnabled) {
        const arr = raw.groupActiveMsgEnabled;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.groupActiveMsgEnabled = new Map(Array.isArray(arr) ? arr.filter(([k, v]) => typeof k === "string" && k.length <= 256 && typeof v === "boolean") : []);
        if (this.groupActiveMsgEnabled.size < totalRaw) {
          process.stderr.write(`[QQ:${this.name}] restoreQQState: accepted ${this.groupActiveMsgEnabled.size} groupActiveMsgEnabled entries (rejected ${totalRaw - this.groupActiveMsgEnabled.size})
`);
        }
      }
      if (raw.botOpenIdByGroup) {
        const arr = raw.botOpenIdByGroup;
        const totalRaw = Array.isArray(arr) ? arr.length : 0;
        this.botOpenIdByGroup = new Map(Array.isArray(arr) ? arr.filter(([k, v]) => typeof k === "string" && k.length <= 256 && typeof v === "string" && QQ_OPENID_RE.test(v)) : []);
        if (this.botOpenIdByGroup.size < totalRaw) {
          process.stderr.write(`[QQ:${this.name}] restoreQQState: accepted ${this.botOpenIdByGroup.size} botOpenIdByGroup entries (rejected ${totalRaw - this.botOpenIdByGroup.size})
`);
        }
      }
      return true;
    } catch (e) {
      process.stderr.write(`[QQ:${this.name}] Failed to restore QQ state: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`);
      return false;
    }
  }
  /**
   * Backup the global sessions.json before start.ts deletes it on shutdown.
   * Restored on next connect so conversations survive daemon restarts.
   */
  backupGlobalSessions() {
    try {
      if (existsSync2(this.globalSessionsPath)) {
        const data = readFileSync2(this.globalSessionsPath, "utf-8");
        if (data.trim())
          writeFileSync2(this.sessionsBackupPath, data, { mode: 384 });
      }
    } catch (e) {
      process.stderr.write(`[QQ:${this.name}] backupGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}

`);
    }
  }
  restoreGlobalSessions() {
    try {
      if (!existsSync2(this.globalSessionsPath) && existsSync2(this.sessionsBackupPath)) {
        writeFileSync2(this.globalSessionsPath, readFileSync2(this.sessionsBackupPath, "utf-8"), { mode: 384 });
      }
    } catch (e) {
      process.stderr.write(`[QQ:${this.name}] restoreGlobalSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}

`);
    }
  }
  /**
   * Compatibility repair for legacy restored session state where older router
   * code could keep an empty session id after bridge.loadSession() failed to
   * return a session_id.
   *
   * **Fragile**: accesses SessionRouter's private `toSession`/`toTarget`/`toCwd`
   * maps via type coercion. If SessionRouter internals change, this breaks
   * silently. The only signal will be cross-server conversations failing to
   * restore after daemon restart — no crash, no log.
   *
   * Keep this while old persisted files may still exist.
   */
  fixRestoredSessions() {
    try {
      if (!existsSync2(this.globalSessionsPath))
        return;
      const raw = JSON.parse(readFileSync2(this.globalSessionsPath, "utf-8"));
      const r = this.router;
      const tm = r["toSession"];
      const tt = r["toTarget"];
      const tc = r["toCwd"];
      if (!tm || !tt)
        return;
      for (const [key, sid] of tm) {
        if (sid)
          continue;
        const entry = raw[key];
        if (!entry?.sessionId)
          continue;
        const correctId = entry.sessionId;
        const target = entry.target;
        tm.set(key, correctId);
        tt.delete(void 0);
        tt.set(correctId, target);
        if (tc) {
          tc.delete(void 0);
          tc.set(correctId, entry.cwd || "");
        }
      }
    } catch (e) {
      process.stderr.write(`[QQ:${this.name}] fixRestoredSessions failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}

`);
    }
  }
  // ── ReplyMsgId helpers ────────────────────────────────────────
  setReplyMsgId(chatId, msgId) {
    const timestamp = Date.now();
    this.replyMsgId.set(chatId, { msgId, timestamp });
    this.replyContextByMessageId.set(msgId, { chatId, msgId, timestamp });
    this.saveQQState();
  }
  deleteReplyContext(context) {
    this.replyContextByMessageId.delete(context.msgId);
    this.msgSeqMap.delete(context.msgId);
    if (this.replyMsgId.get(context.chatId)?.msgId === context.msgId) {
      this.replyMsgId.delete(context.chatId);
    }
  }
  /**
   * Start periodic cleanup of expired replyMsgId entries.
   * Evicts entries older than 5 minutes every 60 seconds, and cascades
   * to msgSeqMap.
   */
  startReplyMsgIdCleanup() {
    this.stopReplyMsgIdCleanup();
    this.replyMsgIdCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - _QQChannel.REPLY_MSG_ID_TTL_MS;
      let dirty = false;
      for (const context of this.replyContextByMessageId.values()) {
        if (context.timestamp < cutoff) {
          this.deleteReplyContext(context);
          dirty = true;
        }
      }
      for (const [chatId, entry] of this.replyMsgId) {
        if (entry.timestamp < cutoff) {
          this.msgSeqMap.delete(entry.msgId);
          this.replyMsgId.delete(chatId);
          dirty = true;
        }
      }
      if (dirty)
        this.saveQQState();
    }, 6e4);
    this.replyMsgIdCleanupTimer.unref();
  }
  stopReplyMsgIdCleanup() {
    if (this.replyMsgIdCleanupTimer) {
      clearInterval(this.replyMsgIdCleanupTimer);
      this.replyMsgIdCleanupTimer = null;
    }
  }
  // ── Token ──────────────────────────────────────────────────────
  async fetchToken() {
    const safeName = this.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const credsFile = getCredsFilePath(safeName);
    let appID = this.qqConfig.appID;
    let appSecret = this.qqConfig.appSecret;
    if (!appID || !appSecret) {
      const saved = loadCredentials(credsFile);
      if (saved) {
        appID = saved.appId;
        appSecret = saved.appSecret;
        this.qqConfig.appID = appID;
        this.qqConfig.appSecret = appSecret;
      }
    }
    if (!appID || !appSecret) {
      process.stderr.write(`[QQ:${this.name}] No credentials, scan QR code with QQ...
`);
      const creds = await qrCodeLogin();
      appID = creds.appId;
      appSecret = creds.appSecret;
      this.qqConfig.appID = appID;
      this.qqConfig.appSecret = appSecret;
      saveCredentials(credsFile, appID, appSecret);
    }
    const token = await fetchAccessToken(appID, appSecret);
    this.accessToken = token.accessToken;
    this.tokenExpiresAt = Date.now() + token.expiresIn * 1e3;
    this.scheduleTokenRefresh();
  }
  scheduleTokenRefresh() {
    if (this.disposed)
      return;
    this.stopTokenRefresh();
    const ttl = Math.max(0, this.tokenExpiresAt - Date.now());
    const delay = Math.min(ttl * 0.8, Math.max(ttl - 3e4, 1e4));
    if (delay > 0) {
      const tokenReconnectId = this._reconnectId;
      this.tokenRefreshTimer = setTimeout(() => {
        this.fetchToken().catch((e) => {
          if (this.disposed || this._reconnectId !== tokenReconnectId)
            return;
          process.stderr.write(`[QQ:${this.name}] Token refresh failed: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}, will retry

`);
          let retryCount = 0;
          const retry = /* @__PURE__ */ __name(() => {
            if (this.disposed || this._reconnectId !== tokenReconnectId)
              return;
            if (++retryCount > 10) {
              process.stderr.write(`[QQ:${this.name}] FATAL: token refresh exhausted, reconnecting

`);
              this.isReconnecting = true;
              this.disconnect();
              const postDisconnectReconnectId = this._reconnectId;
              this.reconnectTimer = setTimeout(() => {
                if (this._reconnectId !== postDisconnectReconnectId)
                  return;
                this.isReconnecting = false;
                this.disposed = false;
                this.reconnectWithRetry();
              }, 1e3);
              this.reconnectTimer.unref?.();
              return;
            }
            this.tokenRefreshTimer = setTimeout(() => {
              this.fetchToken().catch((e2) => {
                if (this.disposed || this._reconnectId !== tokenReconnectId)
                  return;
                process.stderr.write(`[QQ:${this.name}] Token refresh retry failed (attempt ${retryCount}): ${sanitizeLogText(e2 instanceof Error ? e2.message : String(e2), 200)}

`);
                retry();
              });
            }, 6e4);
            this.tokenRefreshTimer.unref?.();
          }, "retry");
          retry();
        });
      }, delay);
      this.tokenRefreshTimer.unref?.();
    }
  }
  stopTokenRefresh() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }
  // ── WebSocket Gateway ──────────────────────────────────────────
  async connectGateway() {
    if (this.disposed)
      throw new Error("Channel disposed");
    const url = await fetchGatewayUrl(this.accessToken, Boolean(this.qqConfig.sandbox));
    return new Promise((resolve, reject) => {
      this.connectReject = reject;
      this.dialGateway(url, resolve, reject);
    });
  }
  dialGateway(url, resolve, reject) {
    this.ws = new wrapper_default(url);
    const dialed = this.ws;
    this.readyTimeout = setTimeout(() => {
      if (this.ws !== dialed)
        return;
      process.stderr.write(`[QQ:${this.name}] READY timeout after 30s, closing
`);
      this.ws?.close(4002, "READY timeout");
      reject(new Error(`[QQ:${this.name}] READY timeout after 30s`));
    }, 3e4);
    this.readyTimeout.unref?.();
    this.ws.on("open", () => {
      process.stderr.write(`[QQ:${this.name}] WebSocket connected
`);
    });
    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleGatewayMessage(msg, resolve);
      } catch (e) {
        process.stderr.write(`[QQ:${this.name}] Malformed gateway message: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`);
      }
    });
    this.ws.on("close", (code) => {
      if (this.ws !== dialed)
        return;
      process.stderr.write(`[QQ:${this.name}] WebSocket closed (code=${code})
`);
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.stopHeartbeat();
      this.ws = null;
      this._ready = false;
      const shouldReconnect = this.serverRequestedReconnect || code !== 1e3 && (this.maxReconnectAttempts <= 0 || this.reconnectAttempts < this.maxReconnectAttempts);
      this.serverRequestedReconnect = false;
      if (code !== 1e3 && code !== 4e3) {
        this.tryResume = false;
        this.flushQQState();
        this.coldStart = true;
      }
      if (shouldReconnect && this.connectReject) {
        this.connectReject(new Error(`WebSocket closed before READY (code=${code})`));
        this.connectReject = null;
      } else if (shouldReconnect) {
        const delay = Math.min(1e3 * 2 ** this.reconnectAttempts, 3e4);
        process.stderr.write(`[QQ:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}${this.maxReconnectAttempts > 0 ? `/${this.maxReconnectAttempts}` : ""})
`);
        if (!this.isReconnecting) {
          this.reconnectTimer = setTimeout(() => this.reconnectWithRetry(), delay);
          this.reconnectTimer.unref();
        }
      } else if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
        process.stderr.write(`[QQ:${this.name}] FATAL: reconnect exhausted after ${this.maxReconnectAttempts} attempts. Bot is offline until daemon restart.
`);
        if (this.connectReject) {
          this.connectReject(new Error(`WebSocket closed (max reconnect attempts, code=${code})`));
          this.connectReject = null;
        }
      } else {
        if (this.connectReject) {
          this.connectReject(new Error(`WebSocket closed before READY (code=${code})`));
          this.connectReject = null;
        }
      }
    });
    this.ws.on("error", (e) => {
      process.stderr.write(`[QQ:${this.name}] WebSocket error: ${sanitizeLogText(e.message, 200)}
`);
      if (!this.ws || this.ws.readyState !== wrapper_default.OPEN) {
        reject(e);
      }
    });
  }
  /**
   * Finalize READY state across cold-start and warm-reconnect paths.
   * Extracted to eliminate triplication in the READY handler.
   */
  finalizeReady() {
    if (!this.ws || this.disposed)
      return;
    this._ready = true;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.coldStart = false;
    this.attachCronHandler();
  }
  handleGatewayMessage(msg, onReady) {
    const op = msg["op"];
    switch (op) {
      case OpCode.HELLO: {
        this.heartbeatInterval = Math.max(msg["d"]?.["heartbeat_interval"] || 45e3, 5e3);
        this.sendIdentify();
        break;
      }
      case OpCode.DISPATCH: {
        const t = msg["t"];
        const s = msg["s"];
        if (s !== void 0)
          this.seq = s;
        if (t === "READY") {
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.sessionId = msg["d"]?.["session_id"] || "";
          this.tryResume = true;
          this.connectReject = null;
          this.startHeartbeat();
          if (this.coldStart) {
            this.restoreGlobalSessions();
            if (!this.restoreQQState()) {
              process.stderr.write(`[QQ:${this.name}] WARNING: QQ state restore failed \u2014 routing maps are empty, group messages may be misrouted
`);
            }
            this.router.restoreSessions().then(() => {
              this.fixRestoredSessions();
              const all = this.router.getAll?.();
              const count = all?.length ?? 0;
              process.stderr.write(`[QQ:${this.name}] Ready (${count} sessions)
`);
              this.finalizeReady();
              this._checkGroupAllPolicyRequireMention();
              onReady();
            }).catch(() => {
              this.fixRestoredSessions();
              process.stderr.write(`[QQ:${this.name}] WARNING: router session restore failed \u2014 cron messages will be dropped until sessions re-establish
`);
              this.finalizeReady();
              this._checkGroupAllPolicyRequireMention();
              onReady();
            });
          } else {
            process.stderr.write(`[QQ:${this.name}] Ready (warm reconnect, skipping state restore)
`);
            this.finalizeReady();
            this._checkGroupAllPolicyRequireMention();
            onReady();
          }
        } else if (t === "C2C_MESSAGE_CREATE") {
          this.handleC2C(msg["d"]);
        } else if (t === "GROUP_AT_MESSAGE_CREATE") {
          this.handleGroup(msg["d"]);
        } else if (t === "GROUP_MESSAGE_CREATE") {
          this.handleGroupAll(msg["d"]);
        } else if (t === "GROUP_ADD_ROBOT") {
          this.handleGroupAddRobot(msg["d"]);
        } else if (t === "GROUP_DEL_ROBOT") {
          this.handleGroupDelRobot(msg["d"]);
        } else if (t === "GROUP_MSG_REJECT") {
          this.handleGroupMsgToggle(msg["d"], false);
        } else if (t === "GROUP_MSG_RECEIVE") {
          this.handleGroupMsgToggle(msg["d"], true);
        } else if (t === "RESUMED") {
          if (this.readyTimeout) {
            clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
          }
          this.connectReject = null;
          this.finalizeReady();
          this.startHeartbeat();
          onReady();
        }
        break;
      }
      case OpCode.HEARTBEAT_ACK:
        this.lastHeartbeatAck = Date.now();
        break;
      case OpCode.RECONNECT:
        this.serverRequestedReconnect = true;
        this.ws?.close(4e3);
        break;
      case OpCode.INVALID_SESSION:
        process.stderr.write(`[QQ:${this.name}] Server sent INVALID_SESSION, falling back to IDENTIFY
`);
        this.tryResume = false;
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
        this.flushQQState();
        this._ready = false;
        this.coldStart = true;
        this.sendIdentify();
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        this.readyTimeout = setTimeout(() => {
          if (this.ws && (this.ws.readyState === wrapper_default.OPEN || this.ws.readyState === wrapper_default.CONNECTING)) {
            this.ws.close(4002);
            if (this.connectReject) {
              this.connectReject(new Error("Timed out waiting for READY"));
              this.connectReject = null;
            }
          }
        }, 3e4);
        this.readyTimeout.unref?.();
        break;
      default:
        break;
    }
  }
  sendIdentify() {
    if (!this.ws)
      return;
    if (this.tryResume && this.sessionId) {
      process.stderr.write(`[QQ:${this.name}] Sending RESUME (session: ${this.sessionId})
`);
      this.ws.send(JSON.stringify({
        op: OpCode.RESUME,
        d: {
          token: `QQBot ${this.accessToken}`,
          session_id: this.sessionId,
          seq: this.seq
        }
      }));
      return;
    }
    const needsGroupMsg = this.qqConfig.groupAllPolicy === "keyword" || this.qqConfig.groupAllPolicy === "all" || this.qqConfig.groupAllPolicy === "log";
    this.ws.send(JSON.stringify({
      op: OpCode.IDENTIFY,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents: Intent.C2C_MESSAGE | Intent.GROUP_AT_MESSAGE | (needsGroupMsg ? Intent.GROUP_MESSAGE : 0),
        shard: [0, 1],
        properties: {}
      }
    }));
  }
  /**
   * Reconnect loop with retry on gateway fetch failures.
   * Refreshes token before each attempt, and retries GW HTTP failures
   * with exponential backoff. Keeps retrying until success.
   */
  async reconnectWithRetry() {
    if (this.disposed)
      return;
    if (this.isReconnecting)
      return;
    this.isReconnecting = true;
    try {
      const myReconnectId = this._reconnectId;
      const maxGwRetries = this.qqConfig.maxGwRetries ?? 5;
      const unlimitedRetries = maxGwRetries <= 0;
      for (let attempt = 0; unlimitedRetries || attempt < maxGwRetries; attempt++) {
        if (this.disposed || this._reconnectId !== myReconnectId)
          return;
        this.reconnectAttempts++;
        if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
          process.stderr.write(`[QQ:${this.name}] RC: reconnect attempts exhausted, giving up
`);
          return;
        }
        try {
          try {
            await this.fetchToken();
          } catch {
            process.stderr.write(`[QQ:${this.name}] RC: token refresh failed, retrying...
`);
            await this.sleep(2e3);
            if (this.disposed)
              return;
            continue;
          }
          await this.connectGateway();
          this.startReplyMsgIdCleanup();
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const backoff = Math.min(1e3 * 2 ** (attempt + 1), 3e4);
          process.stderr.write(`[QQ:${this.name}] RC: ${sanitizeLogText(msg, 200)} (retry in ${backoff}ms, attempt ${attempt + 1}${unlimitedRetries ? "" : `/${maxGwRetries}`})
`);
          if (unlimitedRetries || attempt < maxGwRetries - 1)
            await this.sleep(backoff);
        }
      }
      process.stderr.write(`[QQ:${this.name}] RC: exhausted ${unlimitedRetries ? "\u221E" : maxGwRetries} reconnect retries, will retry in 60s
`);
      this.tryResume = false;
    } finally {
      this.isReconnecting = false;
    }
    this.reconnectTimer = setTimeout(() => this.reconnectWithRetry(), 6e4);
    this.reconnectTimer.unref();
  }
  sleep(ms) {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeatAck = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== wrapper_default.OPEN)
        return;
      const elapsed = Date.now() - this.lastHeartbeatAck;
      if (elapsed > this.heartbeatInterval * 2) {
        process.stderr.write(`[QQ:${this.name}] Heartbeat ACK timeout (${elapsed}ms), forcing reconnect
`);
        this.ws?.close(4001);
        return;
      }
      this.ws.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq }));
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref();
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  // ── Bot OpenID extraction ──────────────────────────────────────
  extractBotOpenId(mentions, chatId) {
    const selfMention = mentions?.find((m3) => m3.is_you);
    if (!selfMention)
      return "";
    const botOpenId = selfMention.member_openid || selfMention.id || "";
    if (!QQ_OPENID_RE.test(botOpenId)) {
      process.stderr.write(`[QQ:${this.name}] Invalid botOpenId format: ${sanitizeLogText(botOpenId, 64)}
`);
      return "";
    }
    if (chatId) {
      this.botOpenIdByGroup.set(chatId, botOpenId);
      this.saveQQState();
    }
    return botOpenId;
  }
  // ── Message Handlers ───────────────────────────────────────────
  /** Check if a message ID was already processed (reconnect replay dedup). */
  isDuplicate(eventId) {
    if (this.seenMessages.has(eventId))
      return true;
    const now = Date.now();
    this.seenMessages.set(eventId, now);
    if (!this.seenCleanupTimer) {
      this.seenCleanupTimer = setInterval(() => {
        const cutoff = Date.now() - _QQChannel.REPLY_MSG_ID_TTL_MS;
        for (const [id, ts] of this.seenMessages) {
          if (ts < cutoff)
            this.seenMessages.delete(id);
        }
        if (this.seenMessages.size === 0) {
          clearInterval(this.seenCleanupTimer);
          this.seenCleanupTimer = null;
        }
      }, 6e4).unref();
    }
    return false;
  }
  /**
   * Extract common group-message fields shared by handleGroup and handleGroupAll.
   * Returns null when the message has no meaningful text after @-tag stripping.
   */
  prepareGroupMessage(event, chatId, { forceAtMention } = {}) {
    const senderName = event.author?.username || "QQ User";
    const safeName = sanitizeSenderName(senderName);
    const senderOpenId = event.author?.member_openid || event.author?.user_openid || "";
    const senderIdentity = senderOpenId || event.author?.id || "";
    const content = (event.content || "").trim();
    const cleanText = content.replace(/<@[^>]{1,64}>/g, "").trim();
    let mentionIndex = 0;
    const displayContent = content.replace(/<@[^>]{1,64}>/g, (mention) => event.mentions?.[mentionIndex++]?.is_you ? "" : mention).trim();
    const safeCleanText = cleanText.replace(/\[atMention=[^\]]*]/g, "").replace(/\[botOpenId:[^\]]*]/g, "").replace(/\[bot]/g, "").trim();
    const safeDisplayText = displayContent.replace(/\[atMention=[^\]]*]/g, "").replace(/\[botOpenId:[^\]]*]/g, "").replace(/\[bot]/g, "").trim();
    const isAtBot = event.mentions?.some((m3) => m3.is_you) ?? false;
    if (isAtBot && !this.botOpenIdByGroup.has(chatId)) {
      this.extractBotOpenId(event.mentions, chatId);
    }
    if (!cleanText)
      return null;
    const effectiveIsAtBot = forceAtMention ?? isAtBot;
    const rawCommandText = safeCleanText.replace(/<@[^>]{1,64}>/g, "").trim();
    const isSlash = effectiveIsAtBot && rawCommandText.startsWith("/");
    const commandText = sanitizePromptText(rawCommandText);
    const groupBotOpenId = this.botOpenIdByGroup.get(chatId);
    const openIdSuffix = this.qqConfig.allowMention !== false && groupBotOpenId ? ` [botOpenId:${groupBotOpenId}]` : "";
    const suffixFromBotOpenId = this.qqConfig.allowMention !== false && groupBotOpenId ? `
\u673A\u5668\u4EBA OPENID: ${groupBotOpenId}` : "";
    const showSenderOpenId = this.qqConfig.allowMention !== false && !!senderOpenId && QQ_OPENID_RE.test(senderOpenId);
    if (!showSenderOpenId && this.qqConfig.allowMention !== false && senderOpenId) {
      const dedupKey = `${chatId}:${truncateCodePoints(senderOpenId, 64)}`;
      if (!this.warnedSenderOpenIds.has(dedupKey)) {
        this.warnedSenderOpenIds.add(dedupKey);
        if (this.warnedSenderOpenIds.size > 500) {
          this.warnedSenderOpenIds.clear();
        }
        process.stderr.write(`[QQ:${this.name}] Unexpected senderOpenId format: ${sanitizeLogText(senderOpenId, 64)}
`);
      }
    }
    const senderTag = showSenderOpenId ? `(${senderOpenId})` : senderIdentity ? `(${truncateCodePoints(sanitizeSenderName(senderIdentity), 8)}\u2026)` : "";
    const head = `[atMention=${effectiveIsAtBot}]${openIdSuffix} [${safeName}${senderTag}]: `;
    const body = sanitizePromptText(this.qqConfig.allowMention !== false ? safeDisplayText : safeCleanText);
    const text = isSlash ? sanitizePromptText(safeCleanText) : `${head}${body}${suffixFromBotOpenId}`;
    return {
      isAtBot: effectiveIsAtBot,
      isSlash,
      safeName,
      cleanText,
      commandText,
      text,
      senderName
    };
  }
  handleC2C(event) {
    if (this.isDuplicate(event.id))
      return;
    if (!event.content?.trim())
      return;
    if (!event.author) {
      process.stderr.write(`[QQ:${this.name}] C2C message dropped: missing author
`);
      return;
    }
    if (event.author.bot) {
      process.stderr.write(`[QQ:${this.name}] Bot C2C message dropped
`);
      return;
    }
    const chatId = event.author.user_openid || event.author.id;
    if (!chatId) {
      process.stderr.write(`[QQ:${this.name}] C2C message dropped: no chatId for author
`);
      return;
    }
    if (!isValidChatId(chatId)) {
      process.stderr.write(`[QQ:${this.name}] C2C message dropped: invalid chatId (length=${chatId.length})
`);
      return;
    }
    this.chatTypeMap.set(chatId, "c2c");
    this.setReplyMsgId(chatId, event.id);
    const senderName = event.author.username || event.author.id || "QQ User";
    const safeName = sanitizeSenderName(senderName);
    const cleanText = event.content.trim();
    const safeContent = cleanText.replace(/\[atMention=[^\]]*]/g, "").replace(/\[botOpenId:[^\]]*]/g, "").replace(/\[bot]/g, "");
    const isSlash = safeContent.startsWith("/");
    const body = sanitizePromptText(safeContent);
    const text = isSlash ? body : `[atMention=true] [${safeName}]: ${body}`;
    this.handleInbound({
      channelName: this.name,
      senderId: chatId,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: false,
      isMentioned: true,
      isReplyToBot: false,
      ...isSlash ? {} : { alreadyPrefixed: true }
    }).catch((e) => process.stderr.write(`[QQ:${this.name}] C2C handler error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`));
  }
  handleGroup(event) {
    if (!event.group_openid) {
      process.stderr.write(`[QQ:${this.name}] Group message dropped: missing group_openid
`);
      return;
    }
    if (!event.author) {
      process.stderr.write(`[QQ:${this.name}] Group message dropped: missing author
`);
      return;
    }
    if (event.author.bot) {
      process.stderr.write(`[QQ:${this.name}] Bot message dropped in group ${sanitizeLogText(event.group_openid, 64)}
`);
      return;
    }
    const chatId = event.group_openid;
    if (!isValidChatId(chatId)) {
      process.stderr.write(`[QQ:${this.name}] Group message dropped: invalid group_openid
`);
      return;
    }
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, "group");
    if (isNewGroup)
      this.saveQQState();
    const result = this.prepareGroupMessage(event, chatId, {
      forceAtMention: true
    });
    if (!result)
      return;
    const { isSlash, text, commandText, senderName, safeName } = result;
    if (this.isDuplicate(event.id))
      return;
    if (isSlash) {
      process.stderr.write(`[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(commandText.split(/\s/)[0], 64)}
`);
    }
    if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(`[QQ:${this.name}] handleGroup: active messages disabled but @-bot allowed through (passive)
`);
    }
    const senderId = event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(`[QQ:${this.name}] Group message dropped: no senderId for author
`);
      return;
    }
    this.setReplyMsgId(chatId, event.id);
    this.handleInbound({
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      messageId: event.id,
      isGroup: true,
      isMentioned: true,
      isReplyToBot: true,
      ...isSlash ? {} : { alreadyPrefixed: true }
    }).catch((e) => process.stderr.write(`[QQ:${this.name}] Group handler error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`));
  }
  handleGroupAll(event) {
    if (!event.group_openid) {
      process.stderr.write(`[QQ:${this.name}] Group all-message dropped: missing group_openid
`);
      return;
    }
    if (!event.author) {
      process.stderr.write(`[QQ:${this.name}] Group all-message dropped: missing author
`);
      return;
    }
    if (event.author.bot) {
      process.stderr.write(`[QQ:${this.name}] Bot message dropped in group ${sanitizeLogText(event.group_openid, 64)}
`);
      return;
    }
    const chatId = event.group_openid;
    if (!isValidChatId(chatId)) {
      process.stderr.write(`[QQ:${this.name}] Group all-message dropped: invalid group_openid
`);
      return;
    }
    const isNewGroup = !this.chatTypeMap.has(chatId);
    this.chatTypeMap.set(chatId, "group");
    if (isNewGroup)
      this.saveQQState();
    const result = this.prepareGroupMessage(event, chatId);
    if (!result)
      return;
    const { isSlash, text, commandText, senderName, isAtBot, safeName } = result;
    if (!isAtBot) {
      if (this.groupActiveMsgEnabled.get(chatId) === false) {
        process.stderr.write(`[QQ:${this.name}] handleGroupAll blocked: active messages disabled for ${sanitizeLogText(chatId, 64)}
`);
        return;
      }
      const rawPolicy = this.qqConfig.groupAllPolicy;
      const policy = rawPolicy === "keyword" || rawPolicy === "all" ? rawPolicy : "log";
      if (policy === "log") {
        process.stderr.write(`[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: log policy \u2014 message from ${sanitizeLogText(senderName, 64)} not forwarded
`);
        return;
      }
      if (policy === "keyword") {
        if (!this._keywordTriggerCache) {
          this._keywordTriggerCache = (this.qqConfig.keywordTriggers ?? []).filter((kw) => kw.length > 0).map((kw) => {
            const normalized = kw.normalize("NFC");
            const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const firstIsAscii = /^[A-Za-z0-9_]/.test(normalized);
            const lastIsAscii = /[A-Za-z0-9_]$/.test(normalized);
            const lb = firstIsAscii ? "(?:^|[^\\w])" : "";
            const la = lastIsAscii ? "(?:[^\\w]|$)" : "";
            return new RegExp(`${lb}${escaped}${la}`, "i");
          });
        }
        if (this._keywordTriggerCache.length === 0) {
          process.stderr.write(`[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy \u2014 no keywords configured, message from ${sanitizeLogText(senderName, 64)} not forwarded
`);
          return;
        }
        const keywordText = result.cleanText.normalize("NFC");
        const matched = this._keywordTriggerCache.some((re) => re.test(keywordText));
        if (!matched) {
          const now = Date.now();
          const lastLog = this._lastKeywordNoMatchLog.get(chatId) ?? 0;
          if (now - lastLog >= 6e4) {
            this._lastKeywordNoMatchLog.set(chatId, now);
            process.stderr.write(`[QQ:${this.name}] Group ${sanitizeLogText(chatId, 64)}: keyword policy \u2014 no match for message from ${sanitizeLogText(senderName, 64)}
`);
          }
          return;
        }
      }
    } else if (this.groupActiveMsgEnabled.get(chatId) === false) {
      process.stderr.write(`[QQ:${this.name}] handleGroupAll: @-bot message allowed through (passive) despite active messages disabled for ${sanitizeLogText(chatId, 64)}
`);
    }
    if (this.isDuplicate(event.id))
      return;
    if (isSlash) {
      process.stderr.write(`[QQ:${this.name}] Slash cmd from ${sanitizeLogText(safeName, 64)} (${sanitizeLogText(chatId, 64)}): ${sanitizeLogText(commandText.split(/\s/)[0], 64)}
`);
    }
    const senderId = event.author.user_openid || event.author.id || event.author.member_openid;
    if (!senderId) {
      process.stderr.write(`[QQ:${this.name}] Group all-message dropped: no senderId for author
`);
      return;
    }
    this.setReplyMsgId(chatId, event.id);
    this.handleInbound({
      channelName: this.name,
      chatId,
      text,
      senderId,
      senderName,
      messageId: event.id,
      isGroup: true,
      isMentioned: isAtBot,
      isReplyToBot: isAtBot,
      ...isSlash ? {} : { alreadyPrefixed: true }
    }).catch((e) => {
      process.stderr.write(`[QQ:${this.name}] handleGroupAll error: ${sanitizeLogText(e instanceof Error ? e.message : String(e), 200)}
`);
    });
  }
  // ── Group management events ────────────────────────────────────
  handleGroupAddRobot(event) {
    const groupId = event.group_openid;
    if (!groupId) {
      process.stderr.write(`[QQ:${this.name}] handleGroupAddRobot: missing group_openid
`);
      return;
    }
    if (!isValidChatId(groupId)) {
      process.stderr.write(`[QQ:${this.name}] handleGroupAddRobot: invalid group_openid (length=${groupId.length})
`);
      return;
    }
    this.chatTypeMap.set(groupId, "group");
    this.saveQQState();
    process.stderr.write(`[QQ:${this.name}] Added to group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}
`);
  }
  handleGroupDelRobot(event) {
    const groupId = event.group_openid;
    if (!groupId) {
      process.stderr.write(`[QQ:${this.name}] handleGroupDelRobot: missing group_openid
`);
      return;
    }
    if (!isValidChatId(groupId)) {
      process.stderr.write(`[QQ:${this.name}] handleGroupDelRobot: invalid group_openid (length=${groupId.length})
`);
      return;
    }
    this.chatTypeMap.delete(groupId);
    this.groupActiveMsgEnabled.delete(groupId);
    const replyEntry = this.replyMsgId.get(groupId);
    if (replyEntry)
      this.msgSeqMap.delete(replyEntry.msgId);
    this.replyMsgId.delete(groupId);
    for (const context of this.replyContextByMessageId.values()) {
      if (context.chatId === groupId) {
        this.replyContextByMessageId.delete(context.msgId);
        this.msgSeqMap.delete(context.msgId);
      }
    }
    this.botOpenIdByGroup.delete(groupId);
    this._lastKeywordNoMatchLog.delete(groupId);
    let cleanedCron = 0;
    for (const [sid, entry] of this.cronBuffer) {
      const state = this.streamState.get(sid);
      if (state?.chatId === groupId) {
        if (entry.timer)
          clearTimeout(entry.timer);
        this.cronBuffer.delete(sid);
        cleanedCron++;
      }
    }
    let cleanedStreams = 0;
    for (const [sid, state] of this.streamState) {
      if (state.chatId === groupId) {
        if (state.timer)
          clearTimeout(state.timer);
        this.flushingSessions.delete(sid);
        this.pendingStreamDelete.delete(sid);
        this.flushedSessions.delete(sid);
        this.streamState.delete(sid);
        if (this.config.sessionScope !== "single") {
          this.onSessionDied(sid);
        }
        cleanedStreams++;
      }
    }
    this.saveQQState();
    process.stderr.write(`[QQ:${this.name}] Removed from group ${sanitizeLogText(groupId, 64)} by ${sanitizeLogText(event.op_member_openid, 64)}, cleaned ${cleanedStreams} stream(s) and ${cleanedCron} cron buffer(s)
`);
  }
  handleGroupMsgToggle(event, enabled) {
    if (!event.group_openid) {
      process.stderr.write(`[QQ:${this.name}] Group msg toggle dropped: missing group_openid
`);
      return;
    }
    if (!isValidChatId(event.group_openid)) {
      process.stderr.write(`[QQ:${this.name}] Group msg toggle dropped: invalid group_openid
`);
      return;
    }
    this.groupActiveMsgEnabled.set(event.group_openid, enabled);
    this.saveQQState();
    process.stderr.write(`[QQ:${this.name}] Active msg ${enabled ? "enabled" : "disabled"} for group ${sanitizeLogText(event.group_openid, 64)}
`);
  }
};

// packages/channels/qqbot/dist/index.js
var plugin = {
  channelType: "qq",
  displayName: "QQ",
  // Both appID and appSecret are optional at config level because
  // fetchToken() resolves them via a fallback chain:
  //   config values → persisted credentials file → QR code login
  // If we required them here, parseChannelConfig() would reject the config
  // before QQChannel is ever constructed — QR-only login would be unreachable
  // through the built-in channel path.
  requiredConfigFields: [],
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new QQChannel(name, config, bridge, options), "createChannel")
};
export {
  QQChannel,
  plugin
};
