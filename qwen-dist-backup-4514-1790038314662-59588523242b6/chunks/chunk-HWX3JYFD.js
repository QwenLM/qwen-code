// Force strict mode and setup for ESM
"use strict";
import {
  reportChatRecordingFailureToAdapter
} from "./chunk-RA6PKQVM.js";
import {
  StreamJsonOutputAdapter
} from "./chunk-LPRZ7GBH.js";
import {
  ICON,
  SHELL_COMMAND_NAME
} from "./chunk-UOWURAPY.js";
import {
  getTranslatedSourceDisplayMap
} from "./chunk-BQDVNRRN.js";
import {
  appEvents
} from "./chunk-PL2V2PQ2.js";
import {
  theme
} from "./chunk-3NHJLWOD.js";
import {
  require_jsx_runtime
} from "./chunk-SV5PQVQE.js";
import {
  Box_default,
  Text
} from "./chunk-ZTBP4SFC.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  themeManager
} from "./chunk-S7BE3FMA.js";
import {
  getCachedStringWidth,
  toCodePoints
} from "./chunk-47ECGEJC.js";
import {
  createLoadedSettingsAdapter
} from "./chunk-E2DZNQEH.js";
import {
  loadMcpApprovals
} from "./chunk-V7HT4IYM.js";
import {
  SettingScope,
  settingExistsInScope
} from "./chunk-DRYBBTI5.js";
import {
  getCurrentLanguage,
  t,
  ta
} from "./chunk-POMFSBEC.js";
import {
  INITIAL_FOLLOWUP_STATE,
  Logger,
  createFollowupController,
  preserveModelProviderPlaceholders
} from "./chunk-47GVX3K4.js";
import {
  ShellExecutionService,
  allowEditorTypeInSandbox,
  checkHasEditorType,
  compactToolResultDisplayForHistory,
  isGatedMcpScope,
  isSignalTermination,
  resolveBranchName,
  watchRepoBranch
} from "./chunk-MRTRBONQ.js";
import {
  TERMINAL_CSI_REGEX,
  TERMINAL_OSC_REGEX,
  TERMINAL_SHIFT_DCS_REGEX,
  stripTerminalControlSequences
} from "./chunk-IMV5DBIP.js";
import {
  formatMemoryUsage
} from "./chunk-CHEIIBT3.js";
import {
  applyProviderInstallPlan,
  buildInstallPlan,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  getModelsForProviderProtocol,
  resolveBaseUrl,
  shouldShowStep
} from "./chunk-TLS6QN2S.js";
import {
  qwenOAuth2Events,
  sanitizeForOsc
} from "./chunk-6DB6UHY3.js";
import {
  AuthEvent,
  PromptSuggestionEvent,
  logAuth,
  logPromptSuggestion
} from "./chunk-KKGSJZWK.js";
import {
  isBinary
} from "./chunk-B3XJFEEH.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/windowTitle.ts
init_esbuild_shims();
var DEFAULT_WINDOW_TITLE = "qwen";
var MULTIPLEXER_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "DVTM"];
function sanitizeWindowTitle(title) {
  return sanitizeForOsc(title);
}
__name(sanitizeWindowTitle, "sanitizeWindowTitle");
function computeWindowTitle(folderName) {
  return sanitizeWindowTitle(
    process.env["CLI_TITLE"] || `Qwen - ${folderName || DEFAULT_WINDOW_TITLE}`
  );
}
__name(computeWindowTitle, "computeWindowTitle");
function writeTerminalTitle(write, title) {
  const clean = sanitizeWindowTitle(title);
  if (process.platform === "win32") {
    process.title = clean;
  }
  const inMultiplexer = MULTIPLEXER_ENV_KEYS.some((k) => !!process.env[k]);
  if (clean.length === 0) {
    if (inMultiplexer) {
      write("\x1B]2;\x07");
    } else {
      write("\x1B]0;\x07\x1B]2;\x07");
    }
    return;
  }
  if (inMultiplexer) {
    write(`\x1B]2;${clean}\x07`);
  } else {
    const padded = clean.substring(0, 80).padEnd(80, " ");
    write(`\x1B]0;${padded}\x07\x1B]2;${padded}\x07`);
  }
}
__name(writeTerminalTitle, "writeTerminalTitle");
function formatSessionWindowTitle(sessionName, folderName, statusPrefix = "") {
  const base = sessionName ? sanitizeWindowTitle(sessionName) : computeWindowTitle(folderName);
  return sanitizeWindowTitle(statusPrefix + base);
}
__name(formatSessionWindowTitle, "formatSessionWindowTitle");
function titleStatusPrefix(streamingState) {
  switch (streamingState) {
    case "responding" /* Responding */:
      return `${ICON.CIRCLE_LEFT_HALF} `;
    case "waiting_for_confirmation" /* WaitingForConfirmation */:
      return `${ICON.SPARKLE} `;
    default:
      return "";
  }
}
__name(titleStatusPrefix, "titleStatusPrefix");

// packages/cli/src/ui/hooks/useLogger.ts
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var useLogger = /* @__PURE__ */ __name((storage, sessionId) => {
  const [logger, setLogger] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    const newLogger = new Logger(sessionId, storage);
    newLogger.initialize().then(() => {
      if (!cancelled) {
        setLogger(newLogger);
      }
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [storage, sessionId]);
  return logger;
}, "useLogger");

// packages/cli/src/dualOutput/DualOutputBridge.ts
init_esbuild_shims();
import {
  createWriteStream,
  fstatSync,
  openSync,
  constants
} from "node:fs";

// packages/cli/src/nonInteractive/io/index.ts
init_esbuild_shims();

// packages/cli/src/dualOutput/DualOutputBridge.ts
var debugLogger = createDebugLogger("DUAL_OUTPUT");
var SUPPORTED_EVENTS = [
  "system",
  "user",
  "assistant",
  "stream_event",
  "result",
  "control_request",
  "control_response"
];
var DUAL_OUTPUT_PROTOCOL_VERSION = 2;
var MAX_BUFFERED_BYTES = 1024 * 1024;
var DualOutputBridge = class {
  static {
    __name(this, "DualOutputBridge");
  }
  adapter;
  stream;
  sessionId;
  active = true;
  shutdownPromise = null;
  unsubscribeRecordingFailure;
  constructor(config, target, options = {}) {
    this.sessionId = config.getSessionId();
    if ("fd" in target) {
      if (target.fd <= 2) {
        throw new Error(
          `--json-fd ${target.fd}: file descriptors 0 (stdin), 1 (stdout), and 2 (stderr) are reserved. Use fd 3 or higher.`
        );
      }
      try {
        fstatSync(target.fd);
      } catch {
        throw new Error(
          `--json-fd ${target.fd}: file descriptor is not open. The caller must provide this fd via spawn stdio configuration or shell redirection (e.g., 3>/tmp/events.jsonl).`
        );
      }
      this.stream = createWriteStream("", { fd: target.fd });
    } else {
      try {
        const fd = openSync(
          target.filePath,
          constants.O_WRONLY | constants.O_NONBLOCK
        );
        this.stream = createWriteStream("", { fd });
      } catch (err) {
        const code = err.code;
        if (code === "ENXIO") {
          try {
            const fd = openSync(
              target.filePath,
              constants.O_RDWR | constants.O_NONBLOCK
            );
            this.stream = createWriteStream("", { fd });
          } catch (retryErr) {
            if (retryErr.code === "EACCES") {
              throw new Error(
                `--json-file "${target.filePath}": permission denied opening FIFO for read-write. Check read/write permissions on the file and its parent directories, or start a reader before launching Qwen Code.`
              );
            }
            throw retryErr;
          }
        } else if (code === "ENOENT") {
          this.stream = createWriteStream(target.filePath, { flags: "w" });
        } else {
          throw err;
        }
      }
    }
    this.stream.on("error", (err) => {
      const code = err.code;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
        debugLogger.warn("DualOutput: consumer disconnected, disabling");
      } else if (code === "ERR_SYSTEM_ERROR") {
        debugLogger.warn(
          "DualOutput: system error on stream, disabling:",
          err.message
        );
      } else {
        debugLogger.error("DualOutput stream error:", err);
      }
      this.active = false;
    });
    this.adapter = new StreamJsonOutputAdapter(
      config,
      true,
      // includePartialMessages — always emit streaming events
      this.stream
    );
    this.unsubscribeRecordingFailure = typeof config.onChatRecordingFailure === "function" ? config.onChatRecordingFailure((event) => {
      this.emitRecordingFailure(event);
    }) : () => {
    };
    try {
      this.adapter.emitSystemMessage("session_start", {
        session_id: this.sessionId,
        cwd: process.cwd(),
        protocol_version: DUAL_OUTPUT_PROTOCOL_VERSION,
        version: options.version,
        supported_events: [...SUPPORTED_EVENTS]
      });
    } catch (err) {
      debugLogger.error("DualOutput session_start error:", err);
      this.active = false;
    }
  }
  processEvent(event) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.processEvent(event);
    } catch (err) {
      debugLogger.error("DualOutput processEvent error:", err);
      this.active = false;
    }
  }
  startAssistantMessage() {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.startAssistantMessage();
    } catch (err) {
      debugLogger.error("DualOutput startAssistantMessage error:", err);
      this.active = false;
    }
  }
  finalizeAssistantMessage() {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.finalizeAssistantMessage();
    } catch (err) {
      debugLogger.error("DualOutput finalizeAssistantMessage error:", err);
      this.active = false;
    }
  }
  emitUserMessage(parts) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitUserMessage(parts);
    } catch (err) {
      debugLogger.error("DualOutput emitUserMessage error:", err);
      this.active = false;
    }
  }
  emitToolResult(request, response) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitToolResult(request, response);
    } catch (err) {
      debugLogger.error("DualOutput emitToolResult error:", err);
      this.active = false;
    }
  }
  /** Whether the underlying stream is still writable. */
  get isConnected() {
    return this.active;
  }
  disableIfBufferOverflowed() {
    if (this.stream.writableLength > MAX_BUFFERED_BYTES) {
      debugLogger.warn(
        "DualOutput: buffered data exceeds limit, disabling (no consumer draining?)"
      );
      this.active = false;
      this.stream.destroy();
    }
  }
  /**
   * Emits a `can_use_tool` permission request so an external consumer can
   * approve or deny the tool call. Pairs with {@link emitControlResponse}.
   */
  emitPermissionRequest(requestId, toolName, toolUseId, input, blockedPath = null, permissionSuggestions = null) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitPermissionRequest(
        requestId,
        toolName,
        toolUseId,
        input,
        blockedPath,
        permissionSuggestions
      );
    } catch (err) {
      debugLogger.error("DualOutput emitPermissionRequest error:", err);
      this.active = false;
    }
  }
  /**
   * Emits the result of a permission decision (made either in the TUI or by
   * the external consumer) so all observers stay in sync.
   */
  emitControlResponse(requestId, allowed) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitControlResponse(requestId, allowed);
    } catch (err) {
      debugLogger.error("DualOutput emitControlResponse error:", err);
      this.active = false;
    }
  }
  /**
   * Emits a `control_response` with subtype `error` — used when an external
   * `confirmation_response` cannot be satisfied (unknown request_id, the
   * tool call already resolved, stream already closed, etc.). Lets
   * consumers retry or surface the error instead of silently hanging.
   */
  emitControlError(requestId, message) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitControlError(requestId, message);
    } catch (err) {
      debugLogger.error("DualOutput emitControlError error:", err);
      this.active = false;
    }
  }
  /** General-purpose system event escape hatch. */
  emitSystemMessage(subtype, data) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      this.adapter.emitSystemMessage(subtype, data);
    } catch (err) {
      debugLogger.error("DualOutput emitSystemMessage error:", err);
      this.active = false;
    }
  }
  emitRecordingFailure(event) {
    if (!this.active) return;
    this.disableIfBufferOverflowed();
    if (!this.active) return;
    try {
      reportChatRecordingFailureToAdapter(this.adapter, event);
    } catch (err) {
      debugLogger.error("DualOutput recording failure output error:", err);
      this.active = false;
    }
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.unsubscribeRecordingFailure();
    if (this.active) {
      try {
        this.adapter.emitSystemMessage("session_end", {
          session_id: this.sessionId
        });
      } catch {
      }
    }
    this.active = false;
    this.shutdownPromise = new Promise((resolve2) => {
      if (this.stream.closed || this.stream.destroyed) {
        resolve2();
        return;
      }
      const cleanup = /* @__PURE__ */ __name(() => {
        this.stream.off("close", onClose);
        this.stream.off("error", onError);
      }, "cleanup");
      const onClose = /* @__PURE__ */ __name(() => {
        cleanup();
        resolve2();
      }, "onClose");
      const onError = /* @__PURE__ */ __name((err) => {
        debugLogger.debug("DualOutput: stream error during shutdown:", err);
      }, "onError");
      this.stream.once("close", onClose);
      this.stream.once("error", onError);
      try {
        this.stream.end();
      } catch (err) {
        cleanup();
        debugLogger.debug("DualOutput: stream end error during shutdown:", err);
        resolve2();
      }
    });
    return this.shutdownPromise;
  }
};

// packages/cli/src/remoteInput/RemoteInputWatcher.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  openSync as openSync2,
  readSync,
  statSync,
  unwatchFile,
  watchFile
} from "node:fs";
import { createInterface } from "node:readline";
var debugLogger2 = createDebugLogger("REMOTE_INPUT");
var RemoteInputWatcher = class {
  static {
    __name(this, "RemoteInputWatcher");
  }
  submitFn = null;
  confirmationHandler = null;
  queue = [];
  processing = false;
  active = true;
  bytesRead = 0;
  consumedPrefixHash = null;
  reading = false;
  filePath;
  retryTimer = null;
  pollIntervalMs;
  constructor(filePath, options) {
    this.filePath = filePath;
    this.pollIntervalMs = options?.pollIntervalMs ?? 500;
    this.startWatching();
  }
  /**
   * Register the TUI's submit function. Called from AppContainer
   * once useLlmStream's submitQuery is available.
   */
  setSubmitFn(fn) {
    this.submitFn = fn;
    this.processQueue();
  }
  /**
   * Register the handler invoked when a `confirmation_response` command is
   * read from the input file. Used to bridge external approvals back into
   * the tool's `onConfirm` callback.
   */
  setConfirmationHandler(fn) {
    this.confirmationHandler = fn;
  }
  /**
   * Notify the watcher that the TUI has become idle.
   * Call this when streamingState transitions to Idle — it triggers
   * processing of any queued commands that were deferred due to TUI busy.
   */
  notifyIdle() {
    if (this.queue.length > 0 && !this.processing) {
      this.processQueue();
    }
  }
  startWatching() {
    try {
      const stat = statSync(this.filePath);
      this.bytesRead = stat.size;
      this.consumedPrefixHash = this.hashFilePrefix(this.bytesRead);
    } catch {
      this.bytesRead = 0;
      this.consumedPrefixHash = null;
    }
    watchFile(this.filePath, { interval: this.pollIntervalMs }, () => {
      if (!this.active) return;
      this.readNewLines();
    });
    debugLogger2.debug(`RemoteInput: watching ${this.filePath}`);
  }
  /**
   * Manually trigger a check for new input. Returns a promise that resolves
   * once any new lines have been read and processed. In production the
   * `watchFile` poll calls this automatically; tests can call it directly
   * to avoid depending on filesystem-polling timing.
   */
  checkForNewInput() {
    return this.readNewLines();
  }
  readNewLines() {
    if (!this.active || this.reading) return Promise.resolve();
    let currentSize;
    try {
      const stat = statSync(this.filePath);
      currentSize = stat.size;
    } catch {
      return Promise.resolve();
    }
    if (currentSize < this.bytesRead) {
      debugLogger2.debug(
        "RemoteInput: input file shrank, resetting read offset"
      );
      this.bytesRead = 0;
      this.consumedPrefixHash = null;
    } else if (this.hasConsumedPrefixChanged()) {
      debugLogger2.debug(
        "RemoteInput: input file prefix changed, resetting read offset"
      );
      this.bytesRead = 0;
      this.consumedPrefixHash = null;
    }
    if (currentSize <= this.bytesRead) return Promise.resolve();
    const consumeUntil = this.findLastCompleteRecordEnd(
      this.bytesRead,
      currentSize
    );
    if (consumeUntil === null) {
      return Promise.resolve();
    }
    const nextConsumedPrefixHash = this.hashFilePrefix(consumeUntil);
    this.reading = true;
    const stream = createReadStream(this.filePath, {
      start: this.bytesRead,
      end: consumeUntil - 1,
      encoding: "utf-8"
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const cmd = JSON.parse(trimmed);
        if (cmd && cmd.type === "confirmation_response" && typeof cmd.request_id === "string" && typeof cmd.allowed === "boolean") {
          debugLogger2.debug(
            `RemoteInput: confirmation_response for ${cmd.request_id} (allowed=${cmd.allowed})`
          );
          this.confirmationHandler?.(cmd.request_id, cmd.allowed);
        } else if (cmd && cmd.type === "submit" && typeof cmd.text === "string") {
          debugLogger2.debug(
            `RemoteInput: queued command: ${cmd.text.slice(0, 50)}...`
          );
          this.queue.push(
            cmd
          );
        } else {
          debugLogger2.warn(
            `RemoteInput: unknown command type: ${String(cmd?.type)}`
          );
        }
      } catch (_err) {
        debugLogger2.warn(`RemoteInput: failed to parse line: ${trimmed}`);
      }
    });
    return new Promise((resolve2) => {
      rl.on("close", () => {
        this.bytesRead = consumeUntil;
        if (nextConsumedPrefixHash !== null) {
          this.consumedPrefixHash = nextConsumedPrefixHash;
        }
        this.reading = false;
        this.processQueue();
        resolve2();
      });
    });
  }
  findLastCompleteRecordEnd(start, end) {
    if (end <= start) return null;
    let fd = null;
    try {
      fd = openSync2(this.filePath, "r");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - start));
      let remaining = end - start;
      let position = start;
      let lastLineBreak = -1;
      while (remaining > 0) {
        const bytesToRead = Math.min(buffer.length, remaining);
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 10) {
            lastLineBreak = position + i;
          }
        }
        remaining -= bytesRead;
        position += bytesRead;
      }
      return lastLineBreak >= start ? lastLineBreak + 1 : null;
    } catch (err) {
      debugLogger2.warn("RemoteInput: failed to scan complete records:", err);
      return null;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
  }
  hasConsumedPrefixChanged() {
    if (this.bytesRead === 0) {
      return false;
    }
    if (this.consumedPrefixHash === null) {
      debugLogger2.warn(
        "RemoteInput: missing consumed prefix hash, resetting read offset"
      );
      return true;
    }
    const currentHash = this.hashFilePrefix(this.bytesRead);
    if (currentHash === null) {
      debugLogger2.warn(
        "RemoteInput: failed to hash consumed prefix, resetting read offset"
      );
      return true;
    }
    return currentHash !== this.consumedPrefixHash;
  }
  hashFilePrefix(size) {
    if (size <= 0) return null;
    let fd = null;
    try {
      fd = openSync2(this.filePath, "r");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
      let remaining = size;
      let position = 0;
      while (remaining > 0) {
        const bytesToRead = Math.min(buffer.length, remaining);
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) return null;
        hash.update(buffer.subarray(0, bytesRead));
        remaining -= bytesRead;
        position += bytesRead;
      }
      return hash.digest("base64");
    } catch (err) {
      debugLogger2.warn("RemoteInput: failed to hash file prefix:", err);
      return null;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
  }
  async processQueue() {
    if (this.processing || !this.submitFn || this.queue.length === 0) return;
    this.processing = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      while (this.queue.length > 0 && this.active) {
        if (!this.submitFn) break;
        const cmd = this.queue[0];
        debugLogger2.debug(
          `RemoteInput: submitting: ${cmd.text.slice(0, 50)}...`
        );
        try {
          const result = await this.submitFn(cmd.text);
          if (result === false) {
            debugLogger2.debug("RemoteInput: TUI busy, will retry on idle");
            this.scheduleRetry();
            break;
          }
          this.queue.shift();
        } catch (err) {
          debugLogger2.error("RemoteInput: submit failed:", err);
          this.queue.shift();
        }
        if (this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      this.processing = false;
    }
  }
  scheduleRetry() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.queue.length > 0 && !this.processing) {
        this.processQueue();
      }
    }, 2e3);
  }
  shutdown() {
    this.active = false;
    unwatchFile(this.filePath);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.queue.length = 0;
    debugLogger2.debug("RemoteInput: shut down");
  }
};

// packages/cli/src/ui/auth/useAuth.ts
init_esbuild_shims();
var import_react3 = __toESM(require_react(), 1);

// packages/cli/src/ui/hooks/useQwenAuth.ts
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);
var useQwenAuth = /* @__PURE__ */ __name((pendingAuthType, isAuthenticating) => {
  const [qwenAuthState, setQwenAuthState] = (0, import_react2.useState)({
    deviceAuth: null,
    authStatus: "idle",
    authMessage: null
  });
  const isQwenAuth = pendingAuthType === "qwen-oauth" /* QWEN_OAUTH */;
  (0, import_react2.useEffect)(() => {
    if (!isQwenAuth || !isAuthenticating) {
      setQwenAuthState({
        deviceAuth: null,
        authStatus: "idle",
        authMessage: null
      });
      return;
    }
    setQwenAuthState((prev) => ({
      ...prev,
      authStatus: "idle"
    }));
    const handleDeviceAuth = /* @__PURE__ */ __name((deviceAuth) => {
      setQwenAuthState((prev) => ({
        ...prev,
        deviceAuth: {
          verification_uri: deviceAuth.verification_uri,
          verification_uri_complete: deviceAuth.verification_uri_complete,
          user_code: deviceAuth.user_code,
          expires_in: deviceAuth.expires_in,
          device_code: deviceAuth.device_code
        },
        authStatus: "polling"
      }));
    }, "handleDeviceAuth");
    const handleAuthProgress = /* @__PURE__ */ __name((status, message) => {
      setQwenAuthState((prev) => ({
        ...prev,
        authStatus: status,
        authMessage: message || null
      }));
    }, "handleAuthProgress");
    qwenOAuth2Events.on("auth-uri" /* AuthUri */, handleDeviceAuth);
    qwenOAuth2Events.on("auth-progress" /* AuthProgress */, handleAuthProgress);
    return () => {
      qwenOAuth2Events.off("auth-uri" /* AuthUri */, handleDeviceAuth);
      qwenOAuth2Events.off("auth-progress" /* AuthProgress */, handleAuthProgress);
    };
  }, [isQwenAuth, isAuthenticating]);
  const cancelQwenAuth = (0, import_react2.useCallback)(() => {
    qwenOAuth2Events.emit("auth-cancel" /* AuthCancel */);
    setQwenAuthState({
      deviceAuth: null,
      authStatus: "idle",
      authMessage: null
    });
  }, []);
  return {
    qwenAuthState,
    cancelQwenAuth
  };
}, "useQwenAuth");

// packages/cli/src/ui/auth/useAuth.ts
function normalizeModelIds(modelIdsInput) {
  return modelIdsInput.split(",").map((id) => id.trim()).filter((id, index, array) => id.length > 0 && array.indexOf(id) === index);
}
__name(normalizeModelIds, "normalizeModelIds");
function maskApiKey(apiKey) {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return "(not set)";
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}
__name(maskApiKey, "maskApiKey");
var useAuthCommand = /* @__PURE__ */ __name((settings, config, addItem, onAuthChange) => {
  const unAuthenticated = config.getAuthType() === void 0;
  const [authState, setAuthState] = (0, import_react3.useState)(
    unAuthenticated ? "updating" /* Updating */ : "unauthenticated" /* Unauthenticated */
  );
  const [authError, setAuthError] = (0, import_react3.useState)(null);
  const [isAuthenticating, setIsAuthenticating] = (0, import_react3.useState)(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = (0, import_react3.useState)(unAuthenticated);
  const [pendingAuthType, setPendingAuthType] = (0, import_react3.useState)(
    void 0
  );
  const [externalAuthState, setExternalAuthState] = (0, import_react3.useState)(null);
  const { qwenAuthState, cancelQwenAuth } = useQwenAuth(
    pendingAuthType,
    isAuthenticating
  );
  const openedViaCommandRef = (0, import_react3.useRef)(false);
  const onAuthError = (0, import_react3.useCallback)(
    (error) => {
      setAuthError(error);
      if (error) {
        setAuthState("updating" /* Updating */);
        setIsAuthDialogOpen(true);
      }
    },
    [setAuthError, setAuthState]
  );
  const handleAuthFailure = (0, import_react3.useCallback)(
    (error, protocolForTelemetry) => {
      setIsAuthenticating(false);
      setExternalAuthState(null);
      const msg = t("Failed to authenticate. Message: {{message}}", {
        message: getErrorMessage(error)
      });
      onAuthError(msg);
      const effectiveProtocol = protocolForTelemetry ?? pendingAuthType;
      if (effectiveProtocol) {
        logAuth(
          config,
          new AuthEvent(effectiveProtocol, "manual", "error", msg)
        );
      }
    },
    [onAuthError, pendingAuthType, config]
  );
  const completeAuthentication = (0, import_react3.useCallback)(() => {
    setAuthError(null);
    setAuthState("authenticated" /* Authenticated */);
    setPendingAuthType(void 0);
    setIsAuthDialogOpen(false);
    setIsAuthenticating(false);
    onAuthChange?.();
  }, [onAuthChange]);
  const handleProviderSubmit = (0, import_react3.useCallback)(
    async (providerConfig, inputs) => {
      let protocol = inputs.protocol ?? providerConfig.protocol;
      try {
        setPendingAuthType(protocol);
        setIsAuthenticating(true);
        setAuthError(null);
        const plan = buildInstallPlan(
          providerConfig,
          inputs,
          getModelsForProviderProtocol(
            settings.merged.modelProviders,
            inputs.protocol ?? providerConfig.protocol,
            settings.merged.providerProtocol
          ),
          {
            authType: settings.merged.security?.auth?.selectedType,
            id: settings.merged.model?.name,
            baseUrl: settings.merged.model?.baseUrl
          }
        );
        protocol = plan.authType;
        setPendingAuthType(protocol);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: /* @__PURE__ */ __name((mp) => config.reloadModelProvidersConfig(mp), "reloadModelProviders"),
          syncAuthState: /* @__PURE__ */ __name((authType, modelId, baseUrl) => config.syncModelSelection(authType, modelId, baseUrl), "syncAuthState"),
          refreshAuth: /* @__PURE__ */ __name((authType) => config.refreshAuth(authType), "refreshAuth")
        });
        if (!plan.modelSelection && !config.getAuthType()) {
          setIsAuthenticating(false);
          setPendingAuthType(void 0);
          onAuthError(
            t(
              "Service models saved. Configure a conversation model to start chatting."
            )
          );
          return;
        }
        completeAuthentication();
        const feedbackItem = {
          type: "info" /* INFO */,
          text: !plan.modelSelection ? t("Service models saved.") : t(
            "Successfully configured {{provider}}. Use /model to switch models.",
            { provider: providerConfig.label }
          )
        };
        addItem(feedbackItem, Date.now());
        if (openedViaCommandRef.current) {
          openedViaCommandRef.current = false;
          config.getChatRecordingService?.()?.recordSlashCommand({
            phase: "result",
            rawCommand: "/auth",
            outputHistoryItems: [feedbackItem]
          });
        }
        if (plan.modelSelection)
          logAuth(config, new AuthEvent(protocol, "manual", "success"));
      } catch (error) {
        handleAuthFailure(error, protocol);
      }
    },
    [
      settings,
      config,
      completeAuthentication,
      addItem,
      handleAuthFailure,
      onAuthError
    ]
  );
  const openAuthDialog = (0, import_react3.useCallback)(() => {
    openedViaCommandRef.current = true;
    setIsAuthDialogOpen(true);
  }, []);
  const closeAuthDialog = (0, import_react3.useCallback)(() => {
    openedViaCommandRef.current = false;
    setIsAuthDialogOpen(false);
    setAuthError(null);
  }, []);
  const cancelAuthentication = (0, import_react3.useCallback)(() => {
    if (isAuthenticating && pendingAuthType === "qwen-oauth" /* QWEN_OAUTH */) {
      cancelQwenAuth();
    }
    if (isAuthenticating && pendingAuthType) {
      logAuth(config, new AuthEvent(pendingAuthType, "manual", "cancelled"));
    }
    setIsAuthenticating(false);
    setExternalAuthState(null);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [isAuthenticating, pendingAuthType, cancelQwenAuth, config]);
  (0, import_react3.useEffect)(() => {
    const val = process.env["QWEN_DEFAULT_AUTH_TYPE"];
    const valid = [
      "qwen-oauth" /* QWEN_OAUTH */,
      "openai" /* USE_OPENAI */,
      "openai-responses" /* USE_OPENAI_RESPONSES */,
      "anthropic" /* USE_ANTHROPIC */,
      "gemini" /* USE_GEMINI */,
      "vertex-ai" /* USE_VERTEX_AI */
    ];
    if (val && !valid.includes(val)) {
      onAuthError(
        t(
          'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}',
          { value: val, validValues: valid.join(", ") }
        )
      );
    }
  }, [onAuthError]);
  const state = (0, import_react3.useMemo)(
    () => ({
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      qwenAuthState
    }),
    [
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      qwenAuthState
    ]
  );
  const actions = (0, import_react3.useMemo)(
    () => ({
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication
    }),
    [
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication
    ]
  );
  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    pendingAuthType,
    externalAuthState,
    qwenAuthState,
    closeAuthDialog,
    handleProviderSubmit,
    openAuthDialog,
    cancelAuthentication,
    state,
    actions
  };
}, "useAuthCommand");

// packages/cli/src/ui/hooks/useGitBranchName.ts
init_esbuild_shims();
var import_react4 = __toESM(require_react(), 1);
var BRANCH_POLL_INTERVAL_MS = 5e3;
function useGitBranchName(cwd) {
  const [branchName, setBranchName] = (0, import_react4.useState)(void 0);
  const branchNameRef = (0, import_react4.useRef)(branchName);
  branchNameRef.current = branchName;
  (0, import_react4.useEffect)(() => {
    let cancelled = false;
    let dispose;
    let pollTimer;
    let refreshGeneration = 0;
    const refresh = /* @__PURE__ */ __name(async () => {
      const generation = ++refreshGeneration;
      const name = await resolveBranchName(cwd);
      if (!cancelled && generation === refreshGeneration && name !== branchNameRef.current) {
        setBranchName(name);
      }
    }, "refresh");
    const init = /* @__PURE__ */ __name(async () => {
      await refresh();
      if (cancelled) return;
      const disposer = await watchRepoBranch(cwd, () => {
        void refresh().catch(() => {
        });
      });
      if (cancelled) {
        disposer();
      } else {
        dispose = disposer;
      }
      if (!cancelled) {
        pollTimer = setInterval(() => {
          void refresh().catch(() => {
          });
        }, BRANCH_POLL_INTERVAL_MS);
        pollTimer.unref?.();
      }
    }, "init");
    void init().catch(() => {
    });
    return () => {
      cancelled = true;
      dispose?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [cwd]);
  return branchName;
}
__name(useGitBranchName, "useGitBranchName");

// packages/cli/src/ui/hooks/useMcpApproval.ts
init_esbuild_shims();
var import_react5 = __toESM(require_react(), 1);
function sourceLabel(scope) {
  switch (scope) {
    case "workspace":
      return ".qwen/settings.json";
    case "project":
    default:
      return ".mcp.json";
  }
}
__name(sourceLabel, "sourceLabel");
function summarize(config) {
  let summary;
  if (config.httpUrl) {
    summary = `${config.httpUrl} (http)`;
  } else if (config.url) {
    summary = `${config.url} (sse)`;
  } else if (config.command) {
    summary = `${config.command} ${config.args?.join(" ") ?? ""} (stdio)`.replace(
      /\s+\(/,
      " ("
    );
  } else {
    summary = "(unknown transport)";
  }
  const details = [];
  if (config.env && Object.keys(config.env).length > 0) {
    details.push(`env: ${Object.keys(config.env).join(", ")}`);
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    details.push(`headers: ${Object.keys(config.headers).join(", ")}`);
  }
  return details.length > 0 ? `${summary} [${details.join("; ")}]` : summary;
}
__name(summarize, "summarize");
var useMcpApproval = /* @__PURE__ */ __name((config) => {
  const [queue, setQueue] = (0, import_react5.useState)([]);
  const computePending = (0, import_react5.useCallback)(() => {
    if (config.getApprovalMode() === "yolo" /* YOLO */) return [];
    const servers = config.getMcpServers() ?? {};
    const approvals = loadMcpApprovals();
    const root = config.getWorkingDir();
    return Object.entries(servers).filter(([, c]) => isGatedMcpScope(c.scope)).filter(([name, c]) => approvals.getState(root, name, c) === "pending").map(([name, c]) => ({
      name,
      config: c,
      summary: summarize(c),
      source: sourceLabel(c.scope)
    }));
  }, [config]);
  (0, import_react5.useEffect)(() => {
    setQueue(computePending());
  }, [computePending]);
  (0, import_react5.useEffect)(() => {
    const onPendingChanged = /* @__PURE__ */ __name(() => {
      setQueue(computePending());
    }, "onPendingChanged");
    appEvents.on("mcp-pending-approval-changed" /* McpPendingApprovalChanged */, onPendingChanged);
    return () => {
      appEvents.off("mcp-pending-approval-changed" /* McpPendingApprovalChanged */, onPendingChanged);
    };
  }, [computePending]);
  const reconnect = (0, import_react5.useCallback)(
    (name) => {
      config.approveMcpServerForSession(name);
      const registry = config.getToolRegistry();
      void registry?.discoverToolsForServer?.(name)?.catch?.((error) => {
        if (process.env["DEBUG"]) {
          console.error(`MCP reconnect failed for ${name}:`, error);
        }
      });
    },
    [config]
  );
  const handleMcpApprovalSelect = (0, import_react5.useCallback)(
    async (choice) => {
      const approvals = loadMcpApprovals();
      const root = config.getWorkingDir();
      const current = queue[0];
      if (!current) {
        return;
      }
      if (choice === "approve_all" /* APPROVE_ALL */) {
        for (const server of queue) {
          await approvals.setState(
            root,
            server.name,
            server.config,
            "approved"
          );
          reconnect(server.name);
        }
        setQueue([]);
        return;
      }
      if (choice === "approve" /* APPROVE */) {
        await approvals.setState(
          root,
          current.name,
          current.config,
          "approved"
        );
        reconnect(current.name);
      } else {
        await approvals.setState(
          root,
          current.name,
          current.config,
          "rejected"
        );
      }
      setQueue((q) => q.slice(1));
    },
    [config, queue, reconnect]
  );
  return {
    isMcpApprovalDialogOpen: queue.length > 0,
    currentMcpApproval: queue[0],
    pendingMcpApprovals: queue,
    mcpApprovalRemaining: Math.max(0, queue.length - 1),
    handleMcpApprovalSelect
  };
}, "useMcpApproval");

// packages/cli/src/ui/hooks/shellCommandProcessor.ts
init_esbuild_shims();
var import_react6 = __toESM(require_react(), 1);
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
var OUTPUT_UPDATE_INTERVAL_MS = 1e3;
var MAX_OUTPUT_LENGTH = 1e4;
var debugLogger3 = createDebugLogger("SHELL_COMMAND_PROCESSOR");
function copyString(value) {
  return value.split("").join("");
}
__name(copyString, "copyString");
function addShellCommandToLlmHistory(llmClient, rawQuery, resultText) {
  const modelContent = resultText.length > MAX_OUTPUT_LENGTH ? copyString(resultText.substring(0, MAX_OUTPUT_LENGTH)) + "\n... (truncated)" : resultText;
  llmClient.addHistory({
    role: "user",
    parts: [
      {
        text: `I ran the following shell command:
\`\`\`sh
${rawQuery}
\`\`\`

This produced the following result:
\`\`\`
${modelContent}
\`\`\``
      }
    ]
  });
}
__name(addShellCommandToLlmHistory, "addShellCommandToLlmHistory");
var useShellCommandProcessor = /* @__PURE__ */ __name((addItemToHistory, setPendingHistoryItem, onExec, onDebugMessage, config, llmClient, setShellInputFocused, terminalWidth, terminalHeight) => {
  const [activeShellPtyId, setActiveShellPtyId] = (0, import_react6.useState)(null);
  const handleShellCommand = (0, import_react6.useCallback)(
    (rawQuery, abortSignal) => {
      if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
        return false;
      }
      const userMessageTimestamp = Date.now();
      const callId = `shell-${userMessageTimestamp}`;
      addItemToHistory(
        { type: "user_shell", text: rawQuery },
        userMessageTimestamp
      );
      const isWindows = os.platform() === "win32";
      const targetDir = config.getTargetDir();
      let commandToExecute = rawQuery;
      let pwdFilePath;
      if (!isWindows) {
        let command = rawQuery.trim();
        const pwdFileName = `shell_pwd_${crypto.randomBytes(6).toString("hex")}.tmp`;
        pwdFilePath = path.join(os.tmpdir(), pwdFileName);
        const trailingBackslashes = /\\+$/.exec(command)?.[0].length ?? 0;
        if (trailingBackslashes % 2 === 1) {
          command += "\n";
        }
        if (!command.endsWith(";") && !command.endsWith("&")) {
          command += ";";
        }
        commandToExecute = `{ ${command}
}; __code=$?; pwd > "${pwdFilePath}"; exit $__code`;
      }
      const executeCommand = /* @__PURE__ */ __name(async (resolve2) => {
        let lastUpdateTime = Date.now();
        let cumulativeStdout = "";
        let isBinaryStream = false;
        let binaryBytesReceived = 0;
        const initialToolDisplay = {
          callId,
          name: SHELL_COMMAND_NAME,
          description: rawQuery,
          status: "Executing" /* Executing */,
          resultDisplay: "",
          confirmationDetails: void 0
        };
        setPendingHistoryItem({
          type: "tool_group",
          tools: [initialToolDisplay],
          isUserInitiated: true
        });
        let executionPid;
        const abortHandler = /* @__PURE__ */ __name(() => {
          onDebugMessage(
            `Aborting shell command (PID: ${executionPid ?? "unknown"})`
          );
        }, "abortHandler");
        abortSignal.addEventListener("abort", abortHandler, { once: true });
        onDebugMessage(`Executing in ${targetDir}: ${commandToExecute}`);
        const cleanupShellCommand = /* @__PURE__ */ __name(() => {
          abortSignal.removeEventListener("abort", abortHandler);
          if (pwdFilePath && fs.existsSync(pwdFilePath)) {
            fs.unlinkSync(pwdFilePath);
          }
          setActiveShellPtyId(null);
          setShellInputFocused(false);
          resolve2();
        }, "cleanupShellCommand");
        try {
          const activeTheme = themeManager.getActiveTheme();
          const shellExecutionConfig = {
            ...config.getShellExecutionConfig(),
            terminalWidth,
            terminalHeight,
            defaultFg: activeTheme.colors.Foreground,
            defaultBg: activeTheme.colors.Background
          };
          const { pid, result } = await ShellExecutionService.execute(
            commandToExecute,
            targetDir,
            (event) => {
              let shouldUpdate = false;
              switch (event.type) {
                case "data":
                  if (isBinaryStream) break;
                  if (config.getShouldUseNodePtyShell()) {
                    cumulativeStdout = event.chunk;
                    shouldUpdate = true;
                  } else if (typeof event.chunk === "string" && typeof cumulativeStdout === "string") {
                    cumulativeStdout += event.chunk;
                  }
                  break;
                case "binary_detected":
                  isBinaryStream = true;
                  shouldUpdate = true;
                  break;
                case "binary_progress":
                  isBinaryStream = true;
                  binaryBytesReceived = event.bytesReceived;
                  break;
                default: {
                  throw new Error("An unhandled ShellOutputEvent was found.");
                }
              }
              let currentDisplayOutput;
              if (isBinaryStream) {
                if (binaryBytesReceived > 0) {
                  currentDisplayOutput = `[Receiving binary output... ${formatMemoryUsage(
                    binaryBytesReceived
                  )} received]`;
                } else {
                  currentDisplayOutput = "[Binary output detected. Halting stream...]";
                }
              } else {
                currentDisplayOutput = cumulativeStdout;
              }
              if (shouldUpdate || Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                setPendingHistoryItem((prevItem) => {
                  if (prevItem?.type === "tool_group") {
                    return {
                      ...prevItem,
                      tools: prevItem.tools.map(
                        (tool) => tool.callId === callId ? {
                          ...tool,
                          resultDisplay: typeof currentDisplayOutput === "string" ? compactToolResultDisplayForHistory(
                            currentDisplayOutput
                          ) : compactToolResultDisplayForHistory({
                            ansiOutput: currentDisplayOutput
                          })
                        } : tool
                      )
                    };
                  }
                  return prevItem;
                });
                lastUpdateTime = Date.now();
              }
            },
            abortSignal,
            config.getShouldUseNodePtyShell(),
            shellExecutionConfig
          );
          debugLogger3.debug(terminalHeight, terminalWidth);
          executionPid = pid;
          if (pid) {
            setActiveShellPtyId(pid);
            setPendingHistoryItem((prevItem) => {
              if (prevItem?.type === "tool_group") {
                return {
                  ...prevItem,
                  tools: prevItem.tools.map(
                    (tool) => tool.callId === callId ? { ...tool, ptyId: pid } : tool
                  )
                };
              }
              return prevItem;
            });
          }
          result.then((result2) => {
            setPendingHistoryItem(null);
            let mainContent;
            if (isBinary(result2.rawOutput)) {
              mainContent = "[Command produced binary output, which is not shown.]";
            } else {
              mainContent = result2.output.trim() || "(Command produced no output)";
            }
            let finalOutput = mainContent;
            let finalStatus = "Success" /* Success */;
            if (result2.error) {
              finalStatus = "Error" /* Error */;
              finalOutput = `${result2.error.message}
${finalOutput}`;
            } else if (result2.aborted) {
              finalStatus = "Canceled" /* Canceled */;
              finalOutput = `Command was cancelled.
${finalOutput}`;
            } else if (isSignalTermination(result2.signal)) {
              finalStatus = "Error" /* Error */;
              finalOutput = `Command terminated by signal: ${result2.signal}.
${finalOutput}`;
            } else if (result2.exitCode !== 0) {
              finalStatus = "Error" /* Error */;
              finalOutput = `Command exited with code ${result2.exitCode}.
${finalOutput}`;
            }
            if (pwdFilePath && fs.existsSync(pwdFilePath)) {
              const finalPwd = fs.readFileSync(pwdFilePath, "utf8").trim();
              if (finalPwd && finalPwd !== targetDir) {
                const warning = `WARNING: shell mode is stateless; the directory change to '${finalPwd}' will not persist.`;
                finalOutput = `${warning}

${finalOutput}`;
              }
            }
            const finalToolDisplay = {
              ...initialToolDisplay,
              status: finalStatus,
              resultDisplay: compactToolResultDisplayForHistory(finalOutput)
            };
            addItemToHistory(
              {
                type: "tool_group",
                tools: [finalToolDisplay],
                isUserInitiated: true
              },
              userMessageTimestamp
            );
            addShellCommandToLlmHistory(llmClient, rawQuery, finalOutput);
          }).catch((err) => {
            setPendingHistoryItem(null);
            const errorMessage = err instanceof Error ? err.message : String(err);
            addItemToHistory(
              {
                type: "error",
                text: `An unexpected error occurred: ${errorMessage}`
              },
              userMessageTimestamp
            );
          }).finally(() => {
            cleanupShellCommand();
          });
        } catch (err) {
          setPendingHistoryItem(null);
          const errorMessage = err instanceof Error ? err.message : String(err);
          addItemToHistory(
            {
              type: "error",
              text: `An unexpected error occurred: ${errorMessage}`
            },
            userMessageTimestamp
          );
          cleanupShellCommand();
        }
      }, "executeCommand");
      const execPromise = new Promise((resolve2) => {
        executeCommand(resolve2);
      });
      onExec(execPromise);
      return true;
    },
    [
      config,
      onDebugMessage,
      addItemToHistory,
      setPendingHistoryItem,
      onExec,
      llmClient,
      setShellInputFocused,
      terminalHeight,
      terminalWidth
    ]
  );
  return { handleShellCommand, activeShellPtyId };
}, "useShellCommandProcessor");

// packages/cli/src/ui/components/stats-helpers.tsx
init_esbuild_shims();
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var TAB_DEFS = [
  { tab: "session", label: /* @__PURE__ */ __name(() => t("Session"), "label") },
  { tab: "activity", label: /* @__PURE__ */ __name(() => t("Activity"), "label") },
  { tab: "efficiency", label: /* @__PURE__ */ __name(() => t("Efficiency"), "label") }
];
var RANGE_CYCLE = ["all", "month", "week", "today"];
function getHeatmapColors() {
  return {
    0: "#161b22",
    1: "#0e4429",
    2: "#006d32",
    3: "#26a641",
    4: "#39d353"
  };
}
__name(getHeatmapColors, "getHeatmapColors");
function getSeriesColors() {
  return [
    theme.text.link,
    theme.status.error,
    theme.text.accent,
    theme.status.success,
    theme.status.warning,
    theme.text.code
  ];
}
__name(getSeriesColors, "getSeriesColors");
function getRangeLabel(range) {
  const labels = {
    today: t("Today"),
    all: t("All time"),
    week: t("Last 7 days"),
    month: t("Last 30 days")
  };
  return labels[range] ?? range;
}
__name(getRangeLabel, "getRangeLabel");
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}
__name(fmtTokens, "fmtTokens");
function fmtDurationShort(ms) {
  const totalMinutes = Math.floor(ms / 6e4);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes % 1440 / 60);
  const minutes = totalMinutes % 60;
  const d = t("d");
  const h = t("h");
  const m = t("m");
  if (days > 0) return `${days}${d} ${hours}${h} ${minutes}${m}`;
  if (hours > 0) return `${hours}${h} ${minutes}${m}`;
  return `${minutes}${m}`;
}
__name(fmtDurationShort, "fmtDurationShort");
function fmtSuccessBar(rate) {
  const filled = Math.max(0, Math.min(10, Math.round(rate / 10)));
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}
__name(fmtSuccessBar, "fmtSuccessBar");
function getSuccessColor(rate) {
  if (rate >= 95) return theme.status.success;
  if (rate >= 80) return theme.status.warning;
  return theme.status.error;
}
__name(getSuccessColor, "getSuccessColor");
function getCacheColor(rate) {
  if (rate >= 85) return theme.status.success;
  if (rate >= 70) return theme.status.warning;
  return theme.status.error;
}
__name(getCacheColor, "getCacheColor");
var TableRow = /* @__PURE__ */ __name(({ cells }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { children: cells.map((cell, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { width: cell.width, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color: cell.color, bold: cell.bold, children: cell.text }) }, i)) }), "TableRow");

// packages/cli/src/ui/hooks/useFollowupSuggestions.tsx
init_esbuild_shims();
var import_react7 = __toESM(require_react(), 1);
function useFollowupSuggestionsCLI(options = {}) {
  const { enabled = true, onAccept, config, isFocused = true } = options;
  const [state, setState] = (0, import_react7.useState)(INITIAL_FOLLOWUP_STATE);
  const onAcceptRef = (0, import_react7.useRef)(onAccept);
  onAcceptRef.current = onAccept;
  const configRef = (0, import_react7.useRef)(config);
  configRef.current = config;
  const firstKeystrokeAtRef = (0, import_react7.useRef)(0);
  const prevShownAtRef = (0, import_react7.useRef)(0);
  const wasFocusedWhenShownRef = (0, import_react7.useRef)(true);
  (0, import_react7.useEffect)(() => {
    if (state.shownAt > 0 && state.shownAt !== prevShownAtRef.current) {
      prevShownAtRef.current = state.shownAt;
      wasFocusedWhenShownRef.current = isFocused;
      firstKeystrokeAtRef.current = 0;
    } else if (state.shownAt === 0) {
      prevShownAtRef.current = 0;
    }
  }, [state.shownAt, isFocused]);
  const recordKeystroke = (0, import_react7.useCallback)(() => {
    if (firstKeystrokeAtRef.current === 0 && state.isVisible) {
      firstKeystrokeAtRef.current = Date.now();
    }
  }, [state.isVisible]);
  const onOutcome = (0, import_react7.useCallback)(
    (params) => {
      const cfg = configRef.current;
      if (!cfg) return;
      logPromptSuggestion(
        cfg,
        new PromptSuggestionEvent({
          outcome: params.outcome,
          accept_method: params.accept_method,
          accept_source: params.accept_source,
          ...params.outcome === "accepted" ? { time_to_accept_ms: params.time_ms } : { time_to_ignore_ms: params.time_ms },
          // Skip for fallback accepts: the suggestion was never shown via the
          // timer (shownAt stayed 0), so `prevShownAtRef` still holds a previous
          // suggestion's timestamp and the delta would be meaningless.
          ...params.accept_source !== "fallback" && firstKeystrokeAtRef.current > 0 && prevShownAtRef.current > 0 && {
            time_to_first_keystroke_ms: firstKeystrokeAtRef.current - prevShownAtRef.current
          },
          suggestion_length: params.suggestion_length,
          similarity: params.outcome === "accepted" ? 1 : 0,
          was_focused_when_shown: wasFocusedWhenShownRef.current
        })
      );
    },
    []
  );
  const controller = (0, import_react7.useMemo)(
    () => createFollowupController({
      enabled,
      onStateChange: setState,
      getOnAccept: /* @__PURE__ */ __name(() => onAcceptRef.current, "getOnAccept"),
      onOutcome
    }),
    [enabled, onOutcome]
  );
  (0, import_react7.useEffect)(() => {
    if (!enabled) {
      controller.clear();
    }
    return () => controller.cleanup();
  }, [controller, enabled]);
  return (0, import_react7.useMemo)(
    () => ({
      state,
      setSuggestion: controller.setSuggestion,
      accept: controller.accept,
      dismiss: controller.dismiss,
      clear: controller.clear,
      recordKeystroke
    }),
    [state, controller, recordKeystroke]
  );
}
__name(useFollowupSuggestionsCLI, "useFollowupSuggestionsCLI");

// packages/cli/src/ui/components/AsciiArt.ts
init_esbuild_shims();
var shortAsciiLogo = `
 \u2584\u2584\u2584\u2584\u2584\u2584  \u2584\u2584     \u2584\u2584 \u2584\u2584\u2584\u2584\u2584\u2584\u2584 \u2584\u2584\u2584    \u2584\u2584
\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551    \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551
\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551 \u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551
\u2588\u2588\u2551\u2584\u2584 \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u255D  \u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551
\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u255A\u2588\u2588\u2588\u2554\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551
 \u255A\u2550\u2550\u2580\u2580\u2550\u255D  \u255A\u2550\u2550\u255D\u255A\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D
`;

// packages/cli/src/ui/utils/customBanner.ts
init_esbuild_shims();
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var debugLogger4 = createDebugLogger("BANNER");
var MAX_FILE_BYTES = 64 * 1024;
var MAX_ART_LINES = 200;
var MAX_ART_COLS = 200;
var MAX_TITLE_LENGTH = 80;
var MAX_SUBTITLE_LENGTH = 160;
function resolveCustomBanner(settings) {
  const ui = settings.merged.ui;
  const cache = /* @__PURE__ */ new Map();
  const title = sanitizeTitle(ui?.customBannerTitle);
  const subtitle = sanitizeSubtitle(ui?.customBannerSubtitle);
  const scoped = collectScopedTiers(settings);
  return {
    asciiArt: {
      small: scoped.small && resolveTier(scoped.small.source, scoped.small.dir, cache),
      large: scoped.large && resolveTier(scoped.large.source, scoped.large.dir, cache)
    },
    title,
    subtitle
  };
}
__name(resolveCustomBanner, "resolveCustomBanner");
function collectScopedTiers(settings) {
  const order = [
    settings.system,
    ...settings.isTrusted ? [settings.workspace] : [],
    settings.user,
    settings.systemDefaults
  ];
  let small;
  let large;
  for (const file of order) {
    if (small && large) break;
    const raw = file.settings.ui?.customAsciiArt;
    if (raw === void 0 || raw === null) continue;
    const tiers = normalizeTiers(raw);
    if (!tiers) continue;
    const dir = file.path ? path2.dirname(file.path) : "";
    const considerTier = /* @__PURE__ */ __name((tier, label) => {
      if (tier === void 0) return void 0;
      const isPathSource = typeof tier === "object";
      if (isPathSource && !dir) {
        debugLogger4.warn(
          `Ignoring ui.customAsciiArt.${label}: {path} entry has no owning settings file directory to resolve against.`
        );
        return void 0;
      }
      return { source: tier, dir };
    }, "considerTier");
    if (!small) {
      const next = considerTier(tiers.small, "small");
      if (next) small = next;
    }
    if (!large) {
      const next = considerTier(tiers.large, "large");
      if (next) large = next;
    }
  }
  return { small, large };
}
__name(collectScopedTiers, "collectScopedTiers");
function normalizeTiers(value) {
  if (typeof value === "string") {
    return { small: value, large: value };
  }
  if (!value || typeof value !== "object") {
    debugLogger4.warn(
      "Ignoring ui.customAsciiArt: expected a string, {path}, or {small,large} object."
    );
    return void 0;
  }
  const hasPath = "path" in value && typeof value.path === "string";
  const hasTierKeys = "small" in value || "large" in value;
  if (hasPath && hasTierKeys) {
    debugLogger4.warn(
      "Ignoring ui.customAsciiArt: object combines `path` with `small` / `large`. Use one shape or the other."
    );
    return void 0;
  }
  if (hasPath) {
    return { small: value, large: value };
  }
  if (hasTierKeys) {
    const tiered = value;
    return {
      small: validateSource(tiered.small),
      large: validateSource(tiered.large)
    };
  }
  debugLogger4.warn(
    "Ignoring ui.customAsciiArt: expected a string, {path}, or {small,large} object."
  );
  return void 0;
}
__name(normalizeTiers, "normalizeTiers");
function validateSource(source) {
  if (source === void 0 || source === null) return void 0;
  if (typeof source === "string") return source;
  if (typeof source === "object" && "path" in source && typeof source.path === "string") {
    return { path: source.path };
  }
  debugLogger4.warn(
    "Ignoring ui.customAsciiArt tier: expected a string or {path} object."
  );
  return void 0;
}
__name(validateSource, "validateSource");
function resolveTier(source, ownerDir, cache) {
  if (source === void 0) return void 0;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return void 0;
    const key = `inline:${source}`;
    return memo(cache, key, () => sanitizeArt(source));
  }
  const resolvedPath = path2.isAbsolute(source.path) ? source.path : path2.resolve(ownerDir, source.path);
  return memo(cache, `path:${resolvedPath}`, () => {
    const raw = readArtFile(resolvedPath);
    if (raw === void 0) return void 0;
    return sanitizeArt(raw);
  });
}
__name(resolveTier, "resolveTier");
function memo(cache, key, compute) {
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = compute();
  cache.set(key, { value });
  return value;
}
__name(memo, "memo");
function readArtFile(absolutePath) {
  let fd;
  try {
    let preOpenStat;
    try {
      preOpenStat = fs2.lstatSync(absolutePath);
    } catch (err) {
      debugLogger4.warn(
        `Failed to stat ui.customAsciiArt at ${absolutePath}: ${err.message}`
      );
      return void 0;
    }
    if (!preOpenStat.isFile()) {
      debugLogger4.warn(
        `Ignoring ui.customAsciiArt: ${absolutePath} is not a regular file.`
      );
      return void 0;
    }
    const flags = typeof fs2.constants.O_NOFOLLOW === "number" ? fs2.constants.O_RDONLY | fs2.constants.O_NOFOLLOW : fs2.constants.O_RDONLY;
    fd = fs2.openSync(absolutePath, flags);
    const stat = fs2.fstatSync(fd);
    if (!stat.isFile()) {
      debugLogger4.warn(
        `Ignoring ui.customAsciiArt: ${absolutePath} is not a regular file.`
      );
      return void 0;
    }
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(size);
    fs2.readSync(fd, buffer, 0, size, 0);
    if (stat.size > MAX_FILE_BYTES) {
      debugLogger4.warn(
        `Truncated ui.customAsciiArt at ${absolutePath}: file is ${stat.size} bytes, capped at ${MAX_FILE_BYTES}.`
      );
    }
    return buffer.toString("utf8");
  } catch (err) {
    debugLogger4.warn(
      `Failed to read ui.customAsciiArt at ${absolutePath}: ${err.message}`
    );
    return void 0;
  } finally {
    if (fd !== void 0) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
  }
}
__name(readArtFile, "readArtFile");
function sanitizeArt(input) {
  let s = input.replace(/\r\n?/g, "\n");
  s = s.replace(TERMINAL_OSC_REGEX, " ").replace(TERMINAL_CSI_REGEX, " ").replace(TERMINAL_SHIFT_DCS_REGEX, " ");
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  const rawLines = s.split("\n");
  const truncatedRows = rawLines.length > MAX_ART_LINES;
  const limitedLines = truncatedRows ? rawLines.slice(0, MAX_ART_LINES) : rawLines;
  let truncatedCols = false;
  const cappedLines = limitedLines.map((line) => {
    const detabbed = line.replace(/\t/g, "  ");
    const trimmed = detabbed.replace(/\s+$/u, "");
    if (getCachedStringWidth(trimmed) <= MAX_ART_COLS) {
      return trimmed;
    }
    truncatedCols = true;
    const codePoints = toCodePoints(trimmed);
    let kept = "";
    for (const cp of codePoints) {
      if (getCachedStringWidth(kept + cp) > MAX_ART_COLS) break;
      kept += cp;
    }
    return kept;
  });
  while (cappedLines.length > 0 && cappedLines[cappedLines.length - 1] === "") {
    cappedLines.pop();
  }
  if (cappedLines.length === 0) return "";
  if (truncatedRows) {
    debugLogger4.warn(`Truncated ui.customAsciiArt to ${MAX_ART_LINES} lines.`);
  }
  if (truncatedCols) {
    debugLogger4.warn(
      `Truncated ui.customAsciiArt to ${MAX_ART_COLS} columns per line.`
    );
  }
  return cappedLines.join("\n");
}
__name(sanitizeArt, "sanitizeArt");
function sanitizeTitle(raw) {
  return sanitizeSingleLine(raw, MAX_TITLE_LENGTH, "ui.customBannerTitle");
}
__name(sanitizeTitle, "sanitizeTitle");
function sanitizeSubtitle(raw) {
  return sanitizeSingleLine(
    raw,
    MAX_SUBTITLE_LENGTH,
    "ui.customBannerSubtitle"
  );
}
__name(sanitizeSubtitle, "sanitizeSubtitle");
function sanitizeSingleLine(raw, maxLength, fieldLabel) {
  if (typeof raw !== "string") return void 0;
  let t2 = stripTerminalControlSequences(raw).replace(/\s+/g, " ").trim();
  if (!t2) return void 0;
  if (t2.length > maxLength) {
    debugLogger4.warn(`Truncated ${fieldLabel} to ${maxLength} characters.`);
    t2 = t2.slice(0, maxLength);
  }
  return t2;
}
__name(sanitizeSingleLine, "sanitizeSingleLine");
function pickAsciiArtTier(small, large, availableWidth, logoGap, minInfoPanelWidth, measureWidth) {
  for (const candidate of [large, small]) {
    if (!candidate) continue;
    const w = measureWidth(candidate);
    if (availableWidth >= w + logoGap + minInfoPanelWidth) {
      return candidate;
    }
  }
  return void 0;
}
__name(pickAsciiArtTier, "pickAsciiArtTier");

// packages/cli/src/ui/hooks/usePhraseCycler.ts
init_esbuild_shims();
var import_react8 = __toESM(require_react(), 1);
var WITTY_LOADING_PHRASES = ["I'm Feeling Lucky"];
var PHRASE_CHANGE_INTERVAL_MS = 15e3;
var usePhraseCycler = /* @__PURE__ */ __name((isActive, isWaiting, customPhrases) => {
  const currentLanguage = getCurrentLanguage();
  const loadingPhrases = (0, import_react8.useMemo)(() => {
    if (customPhrases && customPhrases.length > 0) {
      return customPhrases;
    }
    const translatedPhrases = ta("WITTY_LOADING_PHRASES");
    return translatedPhrases.length > 0 ? translatedPhrases : WITTY_LOADING_PHRASES;
  }, [customPhrases, currentLanguage]);
  const [currentLoadingPhrase, setCurrentLoadingPhrase] = (0, import_react8.useState)(
    loadingPhrases[0]
  );
  const phraseIntervalRef = (0, import_react8.useRef)(null);
  (0, import_react8.useEffect)(() => {
    if (isWaiting) {
      setCurrentLoadingPhrase(t("Waiting for user confirmation..."));
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    } else if (isActive) {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
      }
      const initialRandomIndex = Math.floor(
        Math.random() * loadingPhrases.length
      );
      setCurrentLoadingPhrase(loadingPhrases[initialRandomIndex]);
      phraseIntervalRef.current = setInterval(() => {
        const randomIndex = Math.floor(Math.random() * loadingPhrases.length);
        setCurrentLoadingPhrase(loadingPhrases[randomIndex]);
      }, PHRASE_CHANGE_INTERVAL_MS);
    } else {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
      setCurrentLoadingPhrase(loadingPhrases[0]);
    }
    return () => {
      if (phraseIntervalRef.current) {
        clearInterval(phraseIntervalRef.current);
        phraseIntervalRef.current = null;
      }
    };
  }, [isActive, isWaiting, loadingPhrases]);
  return currentLoadingPhrase;
}, "usePhraseCycler");

// packages/cli/src/ui/hooks/useTimer.ts
init_esbuild_shims();
var import_react9 = __toESM(require_react(), 1);
var TIMER_REFRESH_INTERVAL_MS = 500;
function elapsedSeconds(elapsedMs) {
  return Number((Math.max(0, elapsedMs) / 1e3).toFixed(1));
}
__name(elapsedSeconds, "elapsedSeconds");
function getRunningElapsedMs(activeSinceMs) {
  if (activeSinceMs === null) {
    return 0;
  }
  return Math.max(0, performance.now() - activeSinceMs);
}
__name(getRunningElapsedMs, "getRunningElapsedMs");
var useTimer = /* @__PURE__ */ __name((isActive, resetKey, isPaused = false) => {
  const [elapsedTime, setElapsedTime] = (0, import_react9.useState)(0);
  const timerRef = (0, import_react9.useRef)(null);
  const activeSinceRef = (0, import_react9.useRef)(null);
  const accumulatedElapsedMsRef = (0, import_react9.useRef)(0);
  const prevResetKeyRef = (0, import_react9.useRef)(resetKey);
  const prevIsActiveRef = (0, import_react9.useRef)(isActive);
  (0, import_react9.useEffect)(() => {
    const clearTimer = /* @__PURE__ */ __name(() => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, "clearTimer");
    const publishElapsedTime = /* @__PURE__ */ __name((elapsedMs) => {
      setElapsedTime(elapsedSeconds(elapsedMs));
    }, "publishElapsedTime");
    const finalizeRunningSegment = /* @__PURE__ */ __name(() => {
      if (activeSinceRef.current !== null) {
        accumulatedElapsedMsRef.current += getRunningElapsedMs(
          activeSinceRef.current
        );
        activeSinceRef.current = null;
      }
      publishElapsedTime(accumulatedElapsedMsRef.current);
    }, "finalizeRunningSegment");
    if (prevResetKeyRef.current !== resetKey || !prevIsActiveRef.current && isActive) {
      accumulatedElapsedMsRef.current = 0;
      activeSinceRef.current = null;
      setElapsedTime(0);
      prevResetKeyRef.current = resetKey;
    }
    if (!isActive) {
      if (prevIsActiveRef.current) {
        finalizeRunningSegment();
      }
      clearTimer();
      prevIsActiveRef.current = isActive;
      return clearTimer;
    }
    if (isPaused) {
      finalizeRunningSegment();
      clearTimer();
      prevIsActiveRef.current = isActive;
      return clearTimer;
    }
    if (activeSinceRef.current === null) {
      activeSinceRef.current = performance.now();
    }
    const updateElapsedTime = /* @__PURE__ */ __name(() => {
      const runningElapsedMs = getRunningElapsedMs(activeSinceRef.current);
      publishElapsedTime(accumulatedElapsedMsRef.current + runningElapsedMs);
    }, "updateElapsedTime");
    clearTimer();
    timerRef.current = setInterval(
      updateElapsedTime,
      TIMER_REFRESH_INTERVAL_MS
    );
    updateElapsedTime();
    prevIsActiveRef.current = isActive;
    return clearTimer;
  }, [isActive, isPaused, resetKey]);
  return elapsedTime;
}, "useTimer");

// packages/cli/src/ui/hooks/useAnimationFrame.ts
init_esbuild_shims();
var import_react10 = __toESM(require_react(), 1);
function useAnimationFrame(watchRef, intervalMs = 50) {
  const [displayValue, setDisplayValue] = (0, import_react10.useState)(() => watchRef.current);
  const displayRef = (0, import_react10.useRef)(watchRef.current);
  const targetRef = (0, import_react10.useRef)(watchRef.current);
  const currentTarget = watchRef.current;
  if (currentTarget < displayRef.current) {
    displayRef.current = currentTarget;
    targetRef.current = currentTarget;
  }
  (0, import_react10.useEffect)(() => {
    if (intervalMs === null) return;
    const current = watchRef.current;
    if (current !== targetRef.current) {
      targetRef.current = current;
      if (current < displayRef.current) {
        displayRef.current = current;
        setDisplayValue(current);
      }
    }
    const id = setInterval(() => {
      const realValue = watchRef.current;
      targetRef.current = realValue;
      if (realValue < displayRef.current) {
        displayRef.current = realValue;
        setDisplayValue(realValue);
        return;
      }
      const gap = realValue - displayRef.current;
      if (gap <= 0) return;
      let increment;
      if (gap < 70) {
        increment = 3;
      } else if (gap <= 200) {
        increment = Math.max(3, Math.round(gap * 0.2));
      } else {
        increment = 50;
      }
      const next = Math.min(displayRef.current + increment, realValue);
      displayRef.current = next;
      setDisplayValue(next);
    }, intervalMs);
    return () => clearInterval(id);
  }, [watchRef, intervalMs]);
  return Math.min(displayValue, currentTarget);
}
__name(useAnimationFrame, "useAnimationFrame");

// packages/cli/src/ui/utils/isNarrowWidth.ts
init_esbuild_shims();
function isNarrowWidth(width) {
  return width < 80;
}
__name(isNarrowWidth, "isNarrowWidth");

// packages/cli/src/services/extension-components-summary.ts
init_esbuild_shims();
function extensionComponentsSummary(extension) {
  const parts = [];
  const mcpCount = extension.mcpServers ? Object.keys(extension.mcpServers).length : 0;
  if (mcpCount) parts.push(t("{{count}} MCP", { count: String(mcpCount) }));
  if (extension.skills?.length)
    parts.push(
      t("{{count}} Skills", { count: String(extension.skills.length) })
    );
  if (extension.commands?.length)
    parts.push(
      t("{{count}} Commands", { count: String(extension.commands.length) })
    );
  if (extension.agents?.length)
    parts.push(
      t("{{count}} Agents", { count: String(extension.agents.length) })
    );
  if (extension.workflows?.length)
    parts.push(
      t("{{count}} Workflows", { count: String(extension.workflows.length) })
    );
  return parts.length ? parts.join(" \xB7 ") : t("None");
}
__name(extensionComponentsSummary, "extensionComponentsSummary");

// packages/cli/src/ui/components/mcp/utils.ts
init_esbuild_shims();

// packages/cli/src/ui/components/mcp/constants.ts
init_esbuild_shims();
var VISIBLE_TOOLS_COUNT = 10;
var VISIBLE_RESOURCES_COUNT = 10;
var SOURCE_ORDER = [
  "user",
  "project",
  "workspace",
  "system",
  "extension"
];

// packages/cli/src/ui/components/mcp/utils.ts
function getSourceDisplayName(source) {
  switch (source) {
    case "user":
      return t("User MCPs");
    case "project":
      return t("Project MCPs");
    case "workspace":
      return t("Workspace Settings");
    case "system":
      return t("System Settings");
    case "extension":
      return t("Extension MCPs");
    default:
      return source;
  }
}
__name(getSourceDisplayName, "getSourceDisplayName");
function groupServersBySource(servers) {
  const groups = /* @__PURE__ */ new Map();
  for (const server of servers) {
    const existing = groups.get(server.source);
    if (existing) {
      existing.push(server);
    } else {
      groups.set(server.source, [server]);
    }
  }
  const result = [];
  for (const source of SOURCE_ORDER) {
    const servers2 = groups.get(source);
    if (servers2 && servers2.length > 0) {
      result.push({
        source,
        displayName: getSourceDisplayName(source),
        servers: servers2
      });
    }
  }
  return result;
}
__name(groupServersBySource, "groupServersBySource");
function getStatusColor(status) {
  switch (status) {
    case "connected":
      return "green";
    case "connecting":
      return "yellow";
    case "disconnected":
      return "red";
    default:
      return "gray";
  }
}
__name(getStatusColor, "getStatusColor");
function getStatusIcon(status) {
  switch (status) {
    case "connected":
      return "\u2713";
    case "connecting":
      return "\u2026";
    case "disconnected":
      return "\u2717";
    default:
      return "?";
  }
}
__name(getStatusIcon, "getStatusIcon");
function formatServerCommand(server) {
  const config = server.config;
  if (config.httpUrl) {
    return `${config.httpUrl} (http)`;
  }
  if (config.url) {
    return `${config.url} (sse)`;
  }
  if (config.command) {
    const args = config.args?.join(" ") || "";
    return `${config.command} ${args} (stdio)`.trim();
  }
  return t("Unknown");
}
__name(formatServerCommand, "formatServerCommand");
function isToolValid(name, description) {
  return !!name && !!description;
}
__name(isToolValid, "isToolValid");
function getToolInvalidReasons(name, description) {
  const reasons = [];
  if (!name) reasons.push(t("missing name"));
  if (!description) reasons.push(t("missing description"));
  return reasons;
}
__name(getToolInvalidReasons, "getToolInvalidReasons");

// packages/cli/src/config/dialogScopeUtils.ts
init_esbuild_shims();
var SCOPE_LABELS = {
  ["User" /* User */]: "User Settings",
  ["Workspace" /* Workspace */]: "Workspace Settings"
  // TODO: migrate system settings to user settings
  // we don't want to save settings to system scope, it is a troublemaker
  // comment it out for now.
  // [SettingScope.System]: 'System Settings',
};
function getScopeItems() {
  return [
    { label: SCOPE_LABELS["User" /* User */], value: "User" /* User */ },
    {
      label: SCOPE_LABELS["Workspace" /* Workspace */],
      value: "Workspace" /* Workspace */
    }
    // { label: SCOPE_LABELS[SettingScope.System], value: SettingScope.System },
  ];
}
__name(getScopeItems, "getScopeItems");
function getScopeMessageForSetting(settingKey, selectedScope, settings) {
  const otherScopes = Object.values(SettingScope).filter(
    (scope) => scope !== selectedScope
  );
  const modifiedInOtherScopes = otherScopes.filter((scope) => {
    const scopeSettings = settings.forScope(scope).settings;
    return settingExistsInScope(settingKey, scopeSettings);
  });
  if (modifiedInOtherScopes.length === 0) {
    return "";
  }
  const modifiedScopesStr = modifiedInOtherScopes.join(", ");
  const currentScopeSettings = settings.forScope(selectedScope).settings;
  const existsInCurrentScope = settingExistsInScope(
    settingKey,
    currentScopeSettings
  );
  return existsInCurrentScope ? `(Also modified in ${modifiedScopesStr})` : `(Modified in ${modifiedScopesStr})`;
}
__name(getScopeMessageForSetting, "getScopeMessageForSetting");

// packages/cli/src/ui/auth/useProviderSetupFlow.ts
init_esbuild_shims();
var import_react11 = __toESM(require_react(), 1);
var STEP_ORDER = [
  "protocol",
  "wireApi",
  "baseUrl",
  "apiKey",
  "models",
  "advancedConfig",
  "review"
];
function getVisibleSteps(config, protocol) {
  return STEP_ORDER.filter((step) => {
    if (step === "review") return config.showAdvancedConfig === true;
    return shouldShowStep(config, step, protocol);
  });
}
__name(getVisibleSteps, "getVisibleSteps");
var routeProtocol = /* @__PURE__ */ __name((proto, wireApi) => wireApi === "responses" ? "openai-responses" /* USE_OPENAI_RESPONSES */ : proto, "routeProtocol");
function useProviderSetupFlow(onSubmit, modelProviders, providerProtocol, selection, rawModelProviders) {
  const [provider, setProvider] = (0, import_react11.useState)(null);
  const [visibleSteps, setVisibleSteps] = (0, import_react11.useState)([]);
  const [stepIndex, setStepIndex] = (0, import_react11.useState)(0);
  const [protocol, setProtocol] = (0, import_react11.useState)("openai" /* USE_OPENAI */);
  const [wireApi, setWireApi] = (0, import_react11.useState)("chat-completions");
  const [baseUrl, setBaseUrl] = (0, import_react11.useState)("");
  const [baseUrlPlaceholder, setBaseUrlPlaceholder] = (0, import_react11.useState)("");
  const [baseUrlOptionIndex, setBaseUrlOptionIndex] = (0, import_react11.useState)(0);
  const [baseUrlError, setBaseUrlError] = (0, import_react11.useState)(null);
  const [apiKey, setApiKey] = (0, import_react11.useState)("");
  const [apiKeyError, setApiKeyError] = (0, import_react11.useState)(null);
  const [modelIds, setModelIds] = (0, import_react11.useState)("");
  const [modelIdsError, setModelIdsError] = (0, import_react11.useState)(null);
  const [thinkingEnabled, setThinkingEnabled] = (0, import_react11.useState)(false);
  const [modalityEnabled, setModalityEnabled] = (0, import_react11.useState)(false);
  const [modalityImage, setModalityImage] = (0, import_react11.useState)(true);
  const [modalityVideo, setModalityVideo] = (0, import_react11.useState)(true);
  const [modalityAudio, setModalityAudio] = (0, import_react11.useState)(false);
  const [modalityPdf, setModalityPdf] = (0, import_react11.useState)(false);
  const [contextWindowSize, setContextWindowSize] = (0, import_react11.useState)("");
  const [focusedConfigIndex, setFocusedConfigIndex] = (0, import_react11.useState)(0);
  const currentStep = visibleSteps[stepIndex] ?? null;
  const start = (0, import_react11.useCallback)(
    (config, initialProtocol, existingEnv, existingModelIds) => {
      setProvider(config);
      const initial = initialProtocol ?? config.protocol;
      const proto = initial === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "openai" /* USE_OPENAI */ : initial;
      const steps = getVisibleSteps(config, proto);
      setVisibleSteps(steps);
      setStepIndex(0);
      setProtocol(proto);
      setWireApi(
        initial === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "responses" : "chat-completions"
      );
      const resolved = resolveBaseUrl(config);
      setBaseUrl(resolved);
      setBaseUrlPlaceholder(
        resolved ? "" : getDefaultBaseUrlForProtocol(initial)
      );
      setBaseUrlOptionIndex(0);
      setBaseUrlError(null);
      let prefillKey = "";
      if (existingEnv) {
        const envKeyName = typeof config.envKey === "function" ? config.envKey(proto, resolved) : config.envKey;
        prefillKey = existingEnv[envKeyName] ?? "";
      }
      setApiKey(prefillKey);
      setApiKeyError(null);
      const defaultIds = getDefaultModelIds(config);
      const customIds = existingModelIds ?? [];
      setModelIds([...defaultIds, ...customIds].join(", "));
      setModelIdsError(null);
      setThinkingEnabled(false);
      setModalityEnabled(false);
      setModalityImage(true);
      setModalityVideo(true);
      setModalityAudio(false);
      setModalityPdf(false);
      setContextWindowSize("");
      setFocusedConfigIndex(0);
    },
    []
  );
  const reset = (0, import_react11.useCallback)(() => {
    setProvider(null);
    setVisibleSteps([]);
    setStepIndex(0);
  }, []);
  const goBack = (0, import_react11.useCallback)(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
      return true;
    }
    reset();
    return false;
  }, [stepIndex, reset]);
  const goNext = (0, import_react11.useCallback)(() => {
    setStepIndex((i) => Math.min(i + 1, visibleSteps.length - 1));
  }, [visibleSteps]);
  const selectProtocol = (0, import_react11.useCallback)(
    (selectedProtocol) => {
      const proto = selectedProtocol === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "openai" /* USE_OPENAI */ : selectedProtocol;
      const nextWireApi = selectedProtocol === "openai-responses" /* USE_OPENAI_RESPONSES */ ? "responses" : proto === protocol ? wireApi : "chat-completions";
      setProtocol(proto);
      setWireApi(nextWireApi);
      if (provider) setVisibleSteps(getVisibleSteps(provider, proto));
      setBaseUrl("");
      setBaseUrlPlaceholder(
        getDefaultBaseUrlForProtocol(routeProtocol(proto, nextWireApi))
      );
      setApiKey("");
      setApiKeyError(null);
      goNext();
    },
    [goNext, provider, protocol, wireApi]
  );
  const selectWireApi = (0, import_react11.useCallback)(
    (selectedApi) => {
      setWireApi(selectedApi);
      const nextPlaceholder = getDefaultBaseUrlForProtocol(
        routeProtocol(protocol, selectedApi)
      );
      if (baseUrl === baseUrlPlaceholder) setBaseUrl(nextPlaceholder);
      setBaseUrlPlaceholder(nextPlaceholder);
      goNext();
    },
    [goNext, protocol, baseUrl, baseUrlPlaceholder]
  );
  const selectBaseUrl = (0, import_react11.useCallback)(
    (selectedUrl) => {
      setBaseUrl(selectedUrl);
      setBaseUrlError(null);
      goNext();
    },
    [goNext]
  );
  const submitBaseUrl = (0, import_react11.useCallback)(
    (valueOverride) => {
      const current = valueOverride ?? baseUrl;
      const effective = current.trim() || baseUrlPlaceholder.trim();
      if (!effective) {
        setBaseUrlError(t("Base URL cannot be empty."));
        return false;
      }
      if (!/^https?:\/\//i.test(effective)) {
        setBaseUrlError(t("Base URL must start with http:// or https://."));
        return false;
      }
      if (!current.trim()) {
        setBaseUrl(effective);
      }
      setBaseUrlError(null);
      goNext();
      return true;
    },
    [baseUrl, baseUrlPlaceholder, goNext]
  );
  const changeBaseUrl = (0, import_react11.useCallback)((value) => {
    setBaseUrl(value);
    setBaseUrlError(null);
  }, []);
  const changeApiKey = (0, import_react11.useCallback)((value) => {
    setApiKey(value);
    setApiKeyError(null);
  }, []);
  const buildCurrentInputs = (0, import_react11.useCallback)(
    (overrides) => {
      const multimodal = modalityEnabled ? {
        image: modalityImage || void 0,
        video: modalityVideo || void 0,
        audio: modalityAudio || void 0,
        pdf: modalityPdf || void 0
      } : void 0;
      const ctxSize = parseInt(contextWindowSize, 10);
      const hasAdvanced = thinkingEnabled || modalityEnabled || ctxSize > 0;
      return {
        protocol: provider?.protocolOptions ? protocol : void 0,
        ...provider && shouldShowStep(provider, "wireApi", protocol) ? { wireApi } : {},
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(modelIds),
        advancedConfig: hasAdvanced ? {
          enableThinking: thinkingEnabled || void 0,
          multimodal,
          contextWindowSize: ctxSize > 0 ? ctxSize : void 0
        } : void 0,
        ...overrides
      };
    },
    [
      provider,
      protocol,
      wireApi,
      baseUrl,
      apiKey,
      modelIds,
      modalityEnabled,
      modalityImage,
      modalityVideo,
      modalityAudio,
      modalityPdf,
      contextWindowSize,
      thinkingEnabled
    ]
  );
  const submitOrNext = (0, import_react11.useCallback)(
    (overrides) => {
      if (stepIndex >= visibleSteps.length - 1) {
        if (provider) void onSubmit(provider, buildCurrentInputs(overrides));
      } else {
        goNext();
      }
    },
    [stepIndex, visibleSteps, provider, onSubmit, buildCurrentInputs, goNext]
  );
  const submitApiKey = (0, import_react11.useCallback)(
    (keyOverride) => {
      const trimmed = (keyOverride ?? apiKey).trim();
      if (!trimmed) {
        setApiKeyError(t("API key cannot be empty."));
        return false;
      }
      if (provider?.validateApiKey) {
        const err = provider.validateApiKey(trimmed, baseUrl);
        if (err) {
          setApiKeyError(err);
          return false;
        }
      }
      setApiKeyError(null);
      setApiKey(trimmed);
      submitOrNext({ apiKey: trimmed });
      return true;
    },
    [apiKey, provider, baseUrl, submitOrNext]
  );
  const highlightBaseUrl = (0, import_react11.useCallback)(
    (url) => {
      if (provider && Array.isArray(provider.baseUrl)) {
        const idx = provider.baseUrl.findIndex((o) => o.url === url);
        setBaseUrlOptionIndex(idx >= 0 ? idx : 0);
      }
    },
    [provider]
  );
  const changeModelIds = (0, import_react11.useCallback)((value) => {
    setModelIds(value);
    setModelIdsError(null);
  }, []);
  const clearModelIdsError = (0, import_react11.useCallback)(() => {
    setModelIdsError(null);
  }, []);
  const submitModelIds = (0, import_react11.useCallback)(
    (overrides) => {
      const normalized = overrides?.modelIds ?? normalizeModelIds(modelIds);
      if (normalized.length === 0) {
        setModelIdsError(t("Model IDs cannot be empty."));
        return false;
      }
      setModelIds(normalized.join(", "));
      setModelIdsError(null);
      submitOrNext({ ...overrides, modelIds: normalized });
      return true;
    },
    [modelIds, submitOrNext]
  );
  const advancedOptionCount = modalityEnabled ? 7 : 3;
  const moveAdvancedFocusUp = (0, import_react11.useCallback)(() => {
    setFocusedConfigIndex((v) => v <= 0 ? advancedOptionCount - 1 : v - 1);
  }, [advancedOptionCount]);
  const moveAdvancedFocusDown = (0, import_react11.useCallback)(() => {
    setFocusedConfigIndex((v) => v >= advancedOptionCount - 1 ? 0 : v + 1);
  }, [advancedOptionCount]);
  const toggleFocusedAdvancedOption = (0, import_react11.useCallback)(() => {
    switch (focusedConfigIndex) {
      case 0:
        setThinkingEnabled((v) => !v);
        break;
      case 1:
        setModalityEnabled((v) => !v);
        break;
      case 2:
        setModalityImage((v) => !v);
        break;
      case 3:
        setModalityVideo((v) => !v);
        break;
      case 4:
        setModalityAudio((v) => !v);
        break;
      case 5:
        setModalityPdf((v) => !v);
        break;
      default:
        break;
    }
  }, [focusedConfigIndex]);
  const submitAdvancedConfig = (0, import_react11.useCallback)(() => {
    goNext();
  }, [goNext]);
  const changeContextWindowSize = (0, import_react11.useCallback)((value) => {
    setContextWindowSize(value.replace(/[^0-9]/g, ""));
  }, []);
  const submit = (0, import_react11.useCallback)(() => {
    if (provider) void onSubmit(provider, buildCurrentInputs());
  }, [provider, onSubmit, buildCurrentInputs]);
  const holdsReference = /* @__PURE__ */ __name((value) => typeof value === "string" && /\$\{[^}]+\}/.test(value), "holdsReference");
  const maskCustomHeaders = /* @__PURE__ */ __name((model) => {
    const headers = model.generationConfig?.customHeaders;
    if (!headers) return model;
    return {
      ...model,
      generationConfig: {
        ...model.generationConfig,
        customHeaders: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name,
            holdsReference(value) ? value : "***"
          ])
        )
      }
    };
  }, "maskCustomHeaders");
  const previewModels = /* @__PURE__ */ __name((patch) => (rawModelProviders && modelProviders ? preserveModelProviderPlaceholders(
    patch.models,
    patch.authType,
    modelProviders,
    rawModelProviders,
    providerProtocol
  ) : patch.models).map(maskCustomHeaders), "previewModels");
  const buildPreview = /* @__PURE__ */ __name(() => {
    if (!provider) return { json: "", error: "" };
    try {
      const inputs = buildCurrentInputs();
      const plan = buildInstallPlan(
        provider,
        { ...inputs, apiKey: maskApiKey(inputs.apiKey) },
        getModelsForProviderProtocol(
          modelProviders,
          inputs.protocol ?? provider.protocol,
          providerProtocol
        ),
        selection
      );
      return {
        json: JSON.stringify(
          {
            env: plan.env,
            modelProviders: Object.fromEntries(
              (plan.modelProviders ?? []).map((patch) => [
                patch.authType,
                previewModels(patch)
              ])
            ),
            security: { auth: { selectedType: plan.authType } },
            model: {
              name: plan.modelSelection?.modelId,
              baseUrl: plan.modelSelection?.baseUrl ?? ""
            }
          },
          null,
          2
        ),
        error: ""
      };
    } catch (error) {
      return {
        json: "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }, "buildPreview");
  const preview = currentStep === "review" ? buildPreview() : { json: "", error: "" };
  const state = {
    provider,
    step: currentStep,
    stepIndex: stepIndex + 1,
    // 1-based for display
    totalSteps: visibleSteps.length,
    protocol,
    wireApi,
    baseUrl,
    baseUrlPlaceholder,
    baseUrlOptionIndex,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
    previewJson: preview.json,
    previewError: preview.error
  };
  return {
    state,
    start,
    reset,
    goBack,
    selectProtocol,
    selectWireApi,
    selectBaseUrl,
    highlightBaseUrl,
    submitBaseUrl,
    changeBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    clearModelIdsError,
    submitModelIds,
    moveAdvancedFocusUp,
    moveAdvancedFocusDown,
    toggleFocusedAdvancedOption,
    changeContextWindowSize,
    submitAdvancedConfig,
    submit
  };
}
__name(useProviderSetupFlow, "useProviderSetupFlow");

// packages/cli/src/ui/editors/editorSettingsManager.ts
init_esbuild_shims();
var EDITOR_DISPLAY_NAMES = {
  cursor: "Cursor",
  emacs: "Emacs",
  neovim: "Neovim",
  vim: "Vim",
  vscode: "VS Code",
  vscodium: "VSCodium",
  windsurf: "Windsurf",
  zed: "Zed",
  trae: "Trae"
};
var EditorSettingsManager = class {
  static {
    __name(this, "EditorSettingsManager");
  }
  availableEditors;
  constructor() {
    const editorTypes = Object.keys(
      EDITOR_DISPLAY_NAMES
    ).sort();
    this.availableEditors = [
      {
        name: "None",
        type: "not_set",
        disabled: false
      },
      ...editorTypes.map((type) => {
        const hasEditor = checkHasEditorType(type);
        const isAllowedInSandbox = allowEditorTypeInSandbox(type);
        let labelSuffix = !isAllowedInSandbox ? " (Not available in sandbox)" : "";
        labelSuffix = !hasEditor ? " (Not installed)" : labelSuffix;
        return {
          name: EDITOR_DISPLAY_NAMES[type] + labelSuffix,
          type,
          disabled: !hasEditor || !isAllowedInSandbox
        };
      })
    ];
  }
  getAvailableEditorDisplays() {
    return this.availableEditors;
  }
};
var editorSettingsManager = new EditorSettingsManager();

// packages/cli/src/ui/components/hooks/sourceLabels.ts
init_esbuild_shims();
function formatSourceLabel(source) {
  switch (source) {
    case "user" /* User */:
      return t("User");
    case "project" /* Project */:
      return t("Project");
    case "system" /* System */:
      return t("System");
    case "extensions" /* Extensions */:
      return t("Extension");
    case "session" /* Session */:
      return t("Session");
    default:
      return source;
  }
}
__name(formatSourceLabel, "formatSourceLabel");
function formatSourceLabels(configs) {
  return Array.from(
    new Set(configs.map((config) => formatSourceLabel(config.source)))
  ).join(", ");
}
__name(formatSourceLabels, "formatSourceLabels");
function getConfigSourceDisplay(config) {
  const sourceDisplayMap = getTranslatedSourceDisplayMap();
  if (config.source === "extensions" /* Extensions */) {
    return `${sourceDisplayMap["extensions" /* Extensions */]} (${config.sourceDisplay})`;
  }
  return sourceDisplayMap[config.source] || config.source;
}
__name(getConfigSourceDisplay, "getConfigSourceDisplay");

export {
  computeWindowTitle,
  writeTerminalTitle,
  formatSessionWindowTitle,
  titleStatusPrefix,
  useLogger,
  addShellCommandToLlmHistory,
  useShellCommandProcessor,
  extensionComponentsSummary,
  VISIBLE_TOOLS_COUNT,
  VISIBLE_RESOURCES_COUNT,
  groupServersBySource,
  getStatusColor,
  getStatusIcon,
  formatServerCommand,
  isToolValid,
  getToolInvalidReasons,
  getScopeItems,
  getScopeMessageForSetting,
  TAB_DEFS,
  RANGE_CYCLE,
  getHeatmapColors,
  getSeriesColors,
  getRangeLabel,
  fmtTokens,
  fmtDurationShort,
  fmtSuccessBar,
  getSuccessColor,
  getCacheColor,
  TableRow,
  normalizeModelIds,
  useAuthCommand,
  useProviderSetupFlow,
  EDITOR_DISPLAY_NAMES,
  editorSettingsManager,
  formatSourceLabel,
  formatSourceLabels,
  getConfigSourceDisplay,
  useFollowupSuggestionsCLI,
  shortAsciiLogo,
  resolveCustomBanner,
  pickAsciiArtTier,
  usePhraseCycler,
  useGitBranchName,
  useTimer,
  useAnimationFrame,
  isNarrowWidth,
  useMcpApproval,
  DualOutputBridge,
  RemoteInputWatcher
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt Suggestion Hook for CLI
 *
 * Thin React wrapper around the framework-agnostic controller from core.
 */
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
