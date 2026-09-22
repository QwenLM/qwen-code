// Force strict mode and setup for ESM
"use strict";
import {
  CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS,
  MAX_CHANNEL_LOOP_MCP_IN_FLIGHT,
  createChannelLoopMcpRequest,
  isChannelLoopMcpControlMessage,
  isChannelLoopMcpResultMessage
} from "./chunk-FYJ7W2PI.js";
import {
  registerChannelWorkerPromptAuthorization,
  revokeChannelWorkerPromptAuthorization
} from "./chunk-Z7B6SRPM.js";
import {
  CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
  ChannelWebhookEnqueueError,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  createChannelWebhookTaskMessage,
  isChannelStartupReportMessage,
  isChannelStartupReportType,
  isChannelWebhookEnqueueErrorCode,
  isChannelWebhookTaskResultMessage
} from "./chunk-STUJ7IMZ.js";
import {
  createWorkerDiagnosticRedactor,
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic
} from "./chunk-L3SNMEDW.js";
import {
  channelSelectionNames
} from "./chunk-GDWE23OR.js";
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV
} from "./chunk-GYTKQYDB.js";
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  ChannelDeliveryError,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  createChannelDeliveryMessage,
  isChannelDeliveryResultMessage
} from "./chunk-RKFGE7JH.js";
import {
  EXTERNAL_TOOL_GUARD_TOKEN_ENV
} from "./chunk-3VUENPWF.js";
import {
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import {
  CHANNEL_WORKER_KILL_GRACE_MS,
  CHANNEL_WORKER_STARTUP_TIMEOUT_MS,
  CHANNEL_WORKER_STOP_GRACE_MS
} from "./chunk-CJ3DHN5I.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-worker-supervisor.ts
init_esbuild_shims();
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// packages/cli/src/serve/pem-certificate-blocks.ts
init_esbuild_shims();
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var NODE_EXTRA_CA_CERTS_ENV = "NODE_EXTRA_CA_CERTS";
var ORACLE_TIMEOUT_MS = 1e4;
var ORACLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
var ORACLE_SOURCE = `
const tls = require('node:tls');
if (typeof tls.getCACertificates === 'function') {
  process.stdout.write(JSON.stringify({
    certificates: tls.getCACertificates('extra'),
  }));
} else {
  tls.createSecureContext();
  process.stdout.write(JSON.stringify({ legacy: true }));
}
`;
var ExtraCaInspectionError = class extends Error {
  static {
    __name(this, "ExtraCaInspectionError");
  }
};
var LegacyExtraCaInspectionError = class extends ExtraCaInspectionError {
  static {
    __name(this, "LegacyExtraCaInspectionError");
  }
  constructor() {
    super("Inspecting NODE_EXTRA_CA_CERTS requires Node.js 22.15.0 or newer.");
  }
};
var FailedExtraCaInspectionError = class extends ExtraCaInspectionError {
  static {
    __name(this, "FailedExtraCaInspectionError");
  }
  constructor() {
    super(
      "Inspecting NODE_EXTRA_CA_CERTS failed before its contents could be judged."
    );
  }
};
function scanCertificateBlocks(contents, sourcePath) {
  let dir;
  try {
    dir = sourcePath ? void 0 : mkdtempSync(join(tmpdir(), "qwen-ca-oracle-"));
    const certPath = sourcePath ?? join(dir, "extra-ca.pem");
    if (dir) writeFileSync(certPath, contents, { mode: 384 });
    const oracleEnv = {
      ...process.env,
      [NODE_EXTRA_CA_CERTS_ENV]: certPath
    };
    for (const key of Object.keys(oracleEnv)) {
      if (key.toUpperCase() === "NODE_OPTIONS") delete oracleEnv[key];
    }
    const result = spawnSync(
      process.execPath,
      ["--no-deprecation", "--input-type=commonjs", "-e", ORACLE_SOURCE],
      {
        encoding: "utf8",
        env: oracleEnv,
        maxBuffer: ORACLE_MAX_BUFFER_BYTES,
        timeout: ORACLE_TIMEOUT_MS,
        windowsHide: true
      }
    );
    if (result.error || result.status !== 0) {
      throw new FailedExtraCaInspectionError();
    }
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) {
      throw new FailedExtraCaInspectionError();
    }
    const certificates = Reflect.get(parsed, "certificates");
    if (certificates !== void 0) {
      if (!Array.isArray(certificates) || !certificates.every((item) => typeof item === "string")) {
        throw new FailedExtraCaInspectionError();
      }
      return certificates.map((block) => ({
        block: block.trimEnd(),
        certificate: new X509Certificate(block)
      }));
    }
    if (Reflect.get(parsed, "legacy") !== true) {
      throw new FailedExtraCaInspectionError();
    }
    throw new LegacyExtraCaInspectionError();
  } catch (error) {
    if (error instanceof ExtraCaInspectionError) throw error;
    throw new FailedExtraCaInspectionError();
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
__name(scanCertificateBlocks, "scanCertificateBlocks");
function extractCertificateBlocks(contents, sourcePath) {
  const scanned = scanCertificateBlocks(contents, sourcePath);
  return scanned.length > 0 ? scanned.map((entry) => entry.block) : void 0;
}
__name(extractCertificateBlocks, "extractCertificateBlocks");
function loadableCertificates(contents, sourcePath) {
  const scanned = scanCertificateBlocks(contents, sourcePath);
  return scanned.length > 0 ? scanned.map((entry) => entry.certificate) : void 0;
}
__name(loadableCertificates, "loadableCertificates");

// packages/cli/src/serve/channel-worker-supervisor.ts
var DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS = 45e3;
var MAX_WORKER_LOG_LINE_LENGTH = 4096;
var MAX_WORKER_LOG_BUFFER_LENGTH = 64 * 1024;
var MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH = MAX_WORKER_LOG_BUFFER_LENGTH;
var ChannelWorkerStopError = class extends Error {
  static {
    __name(this, "ChannelWorkerStopError");
  }
  constructor(message = "Channel worker did not exit after SIGKILL.") {
    super(message);
    this.name = "ChannelWorkerStopError";
  }
};
var ChannelWorkerStartupError = class extends Error {
  static {
    __name(this, "ChannelWorkerStartupError");
  }
  startupFailures;
  startupFailuresTruncated;
  constructor(message, details) {
    super(message);
    this.name = "ChannelWorkerStartupError";
    this.startupFailures = details.startupFailures.map((failure) => ({
      ...failure,
      workspaceCwd: details.workspaceCwd
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated === true;
  }
};
var DEFAULT_RESTART_POLICY = {
  maxRestarts: 3,
  windowMs: 5 * 6e4,
  delaysMs: [1e3, 5e3, 15e3]
};
function selectionChannelArgs(selection) {
  return channelSelectionNames(selection).map((name) => `--channel=${name}`);
}
__name(selectionChannelArgs, "selectionChannelArgs");
function defaultSpawnWorker(execPath, argv, options) {
  const child = fork(argv[0], argv.slice(1), {
    execPath,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio
  });
  return child;
}
__name(defaultSpawnWorker, "defaultSpawnWorker");
function isReadyMessage(message) {
  return typeof message === "object" && message !== null && message.type === "ready";
}
__name(isReadyMessage, "isReadyMessage");
function isHeartbeatMessage(message) {
  return typeof message === "object" && message !== null && message.type === "heartbeat";
}
__name(isHeartbeatMessage, "isHeartbeatMessage");
function requestedChannelNames(selection) {
  return selection.mode === "names" ? [...selection.names] : void 0;
}
__name(requestedChannelNames, "requestedChannelNames");
function workerLogRedactionOptions(daemonToken, workerEnv) {
  return {
    ...daemonToken ? { daemonToken } : {},
    workerEnv
  };
}
__name(workerLogRedactionOptions, "workerLogRedactionOptions");
function sanitizeWorkerError(error, redaction) {
  return redaction ? sanitizeWorkerDiagnostic(error, 512, redaction) : sanitizeLogText(normalizeWorkerDiagnostic(error), 512);
}
__name(sanitizeWorkerError, "sanitizeWorkerError");
function notifyExit(onExit, snapshot) {
  try {
    onExit?.(snapshot);
  } catch {
  }
}
__name(notifyExit, "notifyExit");
function notifyReady(onReady, snapshot) {
  try {
    onReady?.(snapshot);
  } catch {
  }
}
__name(notifyReady, "notifyReady");
function notifyLog(onLog, entry) {
  try {
    onLog?.(entry);
  } catch {
  }
}
__name(notifyLog, "notifyLog");
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = /* @__PURE__ */ __name(() => done(true), "onExit");
    const done = /* @__PURE__ */ __name((exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    }, "done");
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}
__name(waitForExit, "waitForExit");
function hasObservedExit(snapshot) {
  return snapshot.exitCode !== void 0 || snapshot.signal !== void 0;
}
__name(hasObservedExit, "hasObservedExit");
var NODE_EXTRA_CA_CERTS_ENV2 = "NODE_EXTRA_CA_CERTS";
var mergedWorkerCaBundles = /* @__PURE__ */ new Map();
function sourceStamp(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}:${stat.size}`;
}
__name(sourceStamp, "sourceStamp");
var warnedWorkerCaMergeFallbacks = /* @__PURE__ */ new Set();
var WORKER_CA_MERGE_FALLBACK_FAMILIES = [
  "read-error",
  "inspection-failed",
  "no-operator-blocks",
  "no-daemon-blocks"
];
function workerCaMergeFallbackKey(operatorCaPath, daemonCertPath, family) {
  return `${operatorCaPath}\0${daemonCertPath}\0${family}`;
}
__name(workerCaMergeFallbackKey, "workerCaMergeFallbackKey");
function warnWorkerCaMergeFallback(operatorCaPath, daemonCertPath, family, reason) {
  const key = workerCaMergeFallbackKey(operatorCaPath, daemonCertPath, family);
  if (warnedWorkerCaMergeFallbacks.has(key)) return;
  warnedWorkerCaMergeFallbacks.add(key);
  process.emitWarning(
    `qwen: failed to merge ${NODE_EXTRA_CA_CERTS_ENV2} "${operatorCaPath}" with the daemon cert "${daemonCertPath}": ${reason}; channel workers will trust only the daemon cert`
  );
}
__name(warnWorkerCaMergeFallback, "warnWorkerCaMergeFallback");
var mintedWorkerCaBundleDirs = /* @__PURE__ */ new Set();
var workerCaBundleExitHookRegistered = false;
function cleanupWorkerCaBundleDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
__name(cleanupWorkerCaBundleDir, "cleanupWorkerCaBundleDir");
function writeMergedWorkerCaBundle(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-worker-ca-"));
  mintedWorkerCaBundleDirs.add(dir);
  if (!workerCaBundleExitHookRegistered) {
    workerCaBundleExitHookRegistered = true;
    process.once("exit", cleanupMintedWorkerCaBundleDirs);
  }
  const bundlePath = path.join(dir, "ca-bundle.pem");
  fs.writeFileSync(bundlePath, contents, { mode: 384 });
  return bundlePath;
}
__name(writeMergedWorkerCaBundle, "writeMergedWorkerCaBundle");
function cleanupMintedWorkerCaBundleDirs() {
  const swept = [...mintedWorkerCaBundleDirs];
  for (const minted of swept) {
    cleanupWorkerCaBundleDir(minted);
  }
  mintedWorkerCaBundleDirs.clear();
  return swept;
}
__name(cleanupMintedWorkerCaBundleDirs, "cleanupMintedWorkerCaBundleDirs");
function resolveWorkerCaCertPath(daemonCertPath, existing) {
  if (!existing || existing === daemonCertPath) return daemonCertPath;
  const cacheKey = `${existing}\0${daemonCertPath}`;
  const sources = [existing, daemonCertPath];
  const cached = mergedWorkerCaBundles.get(cacheKey);
  if (cached) {
    try {
      fs.statSync(cached.bundlePath);
      if (sources.every((src, i) => sourceStamp(src) === cached.sourceStamps[i])) {
        return cached.bundlePath;
      }
    } catch {
    }
  }
  try {
    const sourceStamps = sources.map(sourceStamp);
    const operatorBlocks = extractCertificateBlocks(
      fs.readFileSync(existing, "utf8"),
      existing
    );
    if (!operatorBlocks) {
      warnWorkerCaMergeFallback(
        existing,
        daemonCertPath,
        "no-operator-blocks",
        // Three causes reject a file, not one: markers, decoding, and DER.
        // Blaming markers alone tells an operator whose CA is truncated or
        // hand-edited to fix lines that are already correct — and after boot
        // this warning is the only diagnostic they get, so it has to name the
        // same three the boot-time check does.
        "it holds no PEM certificate block Node can load (every -----BEGIN/END CERTIFICATE----- marker must sit alone on its own line and every block must decode, and a DER file is never read at all)"
      );
      return daemonCertPath;
    }
    const daemonBlocks = extractCertificateBlocks(
      fs.readFileSync(daemonCertPath, "utf8"),
      daemonCertPath
    );
    if (!daemonBlocks) {
      warnWorkerCaMergeFallback(
        existing,
        daemonCertPath,
        "no-daemon-blocks",
        "the daemon cert holds no PEM certificate block to merge into"
      );
      return daemonCertPath;
    }
    const bundlePath = writeMergedWorkerCaBundle(
      `${[...operatorBlocks, ...daemonBlocks].join("\n")}
`
    );
    const superseded = mergedWorkerCaBundles.get(cacheKey);
    mergedWorkerCaBundles.set(cacheKey, { bundlePath, sourceStamps });
    if (superseded) {
      const dir = path.dirname(superseded.bundlePath);
      mintedWorkerCaBundleDirs.delete(dir);
      cleanupWorkerCaBundleDir(dir);
    }
    for (const family of WORKER_CA_MERGE_FALLBACK_FAMILIES) {
      warnedWorkerCaMergeFallbacks.delete(
        workerCaMergeFallbackKey(existing, daemonCertPath, family)
      );
    }
    return bundlePath;
  } catch (err) {
    warnWorkerCaMergeFallback(
      existing,
      daemonCertPath,
      // An inspection that could not run blames nothing about the file's
      // contents; sharing the read-error family would let a first ENOENT
      // silence the later, now-accurate inspection-failure diagnosis.
      err instanceof ExtraCaInspectionError ? "inspection-failed" : "read-error",
      err instanceof Error ? err.message : String(err)
    );
    return daemonCertPath;
  }
}
__name(resolveWorkerCaCertPath, "resolveWorkerCaCertPath");
function createWorkerEnv(opts) {
  const env = { ...opts.baseEnv ?? process.env };
  env["QWEN_CODE_NO_RELAUNCH"] = "true";
  env["QWEN_CODE_SERVE"] = "1";
  if (opts.tlsCaCertPath) {
    env[NODE_EXTRA_CA_CERTS_ENV2] = resolveWorkerCaCertPath(
      opts.tlsCaCertPath,
      env[NODE_EXTRA_CA_CERTS_ENV2]
    );
  }
  env[CHANNEL_DAEMON_WORKER_SENTINEL] = randomUUID();
  env[QWEN_DAEMON_URL_ENV] = opts.daemonUrl;
  env[QWEN_DAEMON_WORKSPACE_ENV] = opts.workspace;
  delete env[QWEN_SERVER_TOKEN_ENV];
  delete env[QWEN_DAEMON_TOKEN_ENV];
  delete env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  if (opts.daemonToken) {
    env[QWEN_DAEMON_TOKEN_ENV] = opts.daemonToken;
  }
  return env;
}
__name(createWorkerEnv, "createWorkerEnv");
function attachWorkerLogStream(stream, streamName, opts) {
  if (!stream) return () => {
  };
  let buffer = "";
  let discardingOversizedLineRemainder = false;
  let discardedOversizedLineRemainderLength = 0;
  const redactWorkerLogLineForStream = createWorkerDiagnosticRedactor({
    ...opts.daemonToken ? { daemonToken: opts.daemonToken } : {},
    workerEnv: opts.workerEnv
  });
  const flushLine = /* @__PURE__ */ __name((line) => {
    const displayLine = line.replace(/\t/gu, " ");
    const redacted = redactWorkerLogLineForStream(
      normalizeWorkerDiagnostic(displayLine)
    );
    notifyLog(opts.onLog, {
      stream: streamName,
      line: sanitizeLogText(redacted, MAX_WORKER_LOG_LINE_LENGTH)
    });
  }, "flushLine");
  const flushPartial = /* @__PURE__ */ __name(() => {
    if (buffer.length === 0) return;
    flushLine(buffer);
    buffer = "";
  }, "flushPartial");
  const flushOversizedBuffer = /* @__PURE__ */ __name(() => {
    if (buffer.length <= MAX_WORKER_LOG_BUFFER_LENGTH) return;
    flushLine(buffer);
    buffer = "";
    discardingOversizedLineRemainder = true;
    discardedOversizedLineRemainderLength = 0;
  }, "flushOversizedBuffer");
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (; ; ) {
      const newlineIndex = buffer.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      const newlineLength = buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(newlineIndex + newlineLength);
      if (!discardingOversizedLineRemainder) {
        flushLine(line);
      }
      discardingOversizedLineRemainder = false;
      discardedOversizedLineRemainderLength = 0;
    }
    if (discardingOversizedLineRemainder) {
      discardedOversizedLineRemainderLength += buffer.length;
      buffer = "";
      if (discardedOversizedLineRemainderLength >= MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH) {
        discardingOversizedLineRemainder = false;
        discardedOversizedLineRemainderLength = 0;
      }
      return;
    }
    flushOversizedBuffer();
  });
  stream.on("end", flushPartial);
  stream.on("close", flushPartial);
  stream.on("error", () => {
    flushPartial();
  });
  return flushPartial;
}
__name(attachWorkerLogStream, "attachWorkerLogStream");
function createChannelWorkerSupervisor(opts) {
  const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
  const restartPolicy = opts.restartPolicy ?? DEFAULT_RESTART_POLICY;
  if (restartPolicy.delaysMs.length === 0) {
    throw new Error("restartPolicy.delaysMs must be non-empty.");
  }
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (heartbeatTimeoutMs > 0 && heartbeatTimeoutMs <= CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS) {
    throw new Error(
      `heartbeatTimeoutMs (${heartbeatTimeoutMs}) must exceed the worker heartbeat interval (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}ms) or be 0 to disable.`
    );
  }
  let child;
  let activePromptAuthorization;
  let snapshot = {
    enabled: true,
    state: "disabled",
    channels: channelSelectionNames(opts.selection),
    restartCount: 0
  };
  let stopping = false;
  let restartTimer;
  let staleHeartbeatTimer;
  let restartAttemptTimes = [];
  const pendingWebhookTasks = /* @__PURE__ */ new Map();
  const pendingChannelDeliveries = /* @__PURE__ */ new Map();
  const pendingChannelLoopMcpMessages = /* @__PURE__ */ new Map();
  let cleanupChannelLoopMcpRegistrations;
  let restarting;
  let disposed = false;
  const snapshotCopy = /* @__PURE__ */ __name(() => ({
    ...snapshot,
    channels: [...snapshot.channels],
    ...snapshot.requestedChannels ? { requestedChannels: [...snapshot.requestedChannels] } : {},
    ...snapshot.startupFailures ? {
      startupFailures: snapshot.startupFailures.map((failure) => ({
        ...failure
      }))
    } : {},
    ...snapshot.adapters ? { adapters: snapshot.adapters.map((adapter) => ({ ...adapter })) } : {}
  }), "snapshotCopy");
  const clearRestartTimer = /* @__PURE__ */ __name(() => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = void 0;
    }
    if (snapshot.nextRestartAt) {
      const next = { ...snapshot };
      delete next.nextRestartAt;
      snapshot = next;
    }
  }, "clearRestartTimer");
  const clearStaleHeartbeatTimer = /* @__PURE__ */ __name(() => {
    if (!staleHeartbeatTimer) return;
    clearTimeout(staleHeartbeatTimer);
    staleHeartbeatTimer = void 0;
  }, "clearStaleHeartbeatTimer");
  const rejectPendingWebhookTasks = /* @__PURE__ */ __name((code, message) => {
    for (const pending of pendingWebhookTasks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelWebhookEnqueueError(code, message));
    }
    pendingWebhookTasks.clear();
  }, "rejectPendingWebhookTasks");
  const rejectPendingWebhookTask = /* @__PURE__ */ __name((id, err) => {
    const pending = pendingWebhookTasks.get(id);
    if (!pending) return;
    pendingWebhookTasks.delete(id);
    clearTimeout(pending.timer);
    pending.reject(err);
  }, "rejectPendingWebhookTask");
  const settleWebhookTask = /* @__PURE__ */ __name((message) => {
    if (!isChannelWebhookTaskResultMessage(message)) return false;
    const pending = pendingWebhookTasks.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingWebhookTasks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ accepted: true });
    } else {
      const code = isChannelWebhookEnqueueErrorCode(message.code) ? message.code : "channel_webhook_enqueue_failed";
      rejectPendingWebhookTask(
        message.id,
        new ChannelWebhookEnqueueError(
          code,
          message.error || "Channel webhook task failed."
        )
      );
    }
    return true;
  }, "settleWebhookTask");
  const rejectPendingChannelDeliveries = /* @__PURE__ */ __name((code, message) => {
    for (const pending of pendingChannelDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelDeliveryError(code, message));
    }
    pendingChannelDeliveries.clear();
  }, "rejectPendingChannelDeliveries");
  const rejectPendingChannelDelivery = /* @__PURE__ */ __name((id, error) => {
    const pending = pendingChannelDeliveries.get(id);
    if (!pending) return;
    pendingChannelDeliveries.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }, "rejectPendingChannelDelivery");
  const settleChannelDelivery = /* @__PURE__ */ __name((message) => {
    if (!isChannelDeliveryResultMessage(message)) return false;
    const pending = pendingChannelDeliveries.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingChannelDeliveries.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ delivered: true });
    } else {
      rejectPendingChannelDelivery(
        message.id,
        new ChannelDeliveryError(
          message.code,
          message.error || "Channel delivery failed."
        )
      );
    }
    return true;
  }, "settleChannelDelivery");
  const rejectPendingChannelLoopMcpMessages = /* @__PURE__ */ __name((message) => {
    for (const pending of pendingChannelLoopMcpMessages.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingChannelLoopMcpMessages.clear();
  }, "rejectPendingChannelLoopMcpMessages");
  const settleChannelLoopMcpMessage = /* @__PURE__ */ __name((message) => {
    if (!isChannelLoopMcpResultMessage(message)) return false;
    const pending = pendingChannelLoopMcpMessages.get(message.id);
    if (!pending) return true;
    pendingChannelLoopMcpMessages.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.payload ?? {});
    } else {
      pending.reject(
        new Error(message.error ?? "Channel loop MCP request failed.")
      );
    }
    return true;
  }, "settleChannelLoopMcpMessage");
  const pruneRestartAttempts = /* @__PURE__ */ __name((nowMs) => {
    restartAttemptTimes = restartAttemptTimes.filter(
      (attemptMs) => nowMs - attemptMs < restartPolicy.windowMs
    );
  }, "pruneRestartAttempts");
  const canScheduleRestart = /* @__PURE__ */ __name((nowMs) => {
    pruneRestartAttempts(nowMs);
    return restartAttemptTimes.length < restartPolicy.maxRestarts;
  }, "canScheduleRestart");
  const nextRestartDelayMs = /* @__PURE__ */ __name(() => {
    const index = Math.min(
      restartAttemptTimes.length,
      restartPolicy.delaysMs.length - 1
    );
    return restartPolicy.delaysMs[index] ?? 0;
  }, "nextRestartDelayMs");
  const setExited = /* @__PURE__ */ __name((state, code, signal, error) => {
    const next = {
      ...snapshot,
      state,
      exitCode: code,
      signal,
      lastExitAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (error) {
      next.error = error;
    } else {
      delete next.error;
    }
    snapshot = {
      ...next
    };
  }, "setExited");
  const scheduleRestart = /* @__PURE__ */ __name(() => {
    if (stopping) return false;
    const nowMs = Date.now();
    if (!canScheduleRestart(nowMs)) {
      const lastError = snapshot.error;
      snapshot = {
        ...snapshot,
        state: "failed",
        error: lastError ? `Channel worker restart budget exhausted. Last error: ${lastError}` : "Channel worker restart budget exhausted.",
        nextRestartAt: void 0
      };
      return false;
    }
    clearRestartTimer();
    const delayMs = nextRestartDelayMs();
    const nextRestartAt = new Date(nowMs + delayMs).toISOString();
    snapshot = {
      ...snapshot,
      nextRestartAt
    };
    restartTimer = setTimeout(() => {
      restartTimer = void 0;
      void launch("restart").catch((err) => {
        handleRestartFailure(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    restartTimer.unref();
    return true;
  }, "scheduleRestart");
  const handleRestartFailure = /* @__PURE__ */ __name((error, redaction) => {
    snapshot = {
      ...snapshot,
      state: "failed",
      error: sanitizeWorkerError(error, redaction)
    };
    scheduleRestart();
    notifyExit(opts.onExit, snapshotCopy());
  }, "handleRestartFailure");
  const armStaleHeartbeatTimer = /* @__PURE__ */ __name((startedChild) => {
    clearStaleHeartbeatTimer();
    if (heartbeatTimeoutMs <= 0) return;
    staleHeartbeatTimer = setTimeout(() => {
      if (child !== startedChild || stopping) return;
      snapshot = {
        ...snapshot,
        error: "Channel worker heartbeat timed out.",
        staleHeartbeatAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      startedChild.kill("SIGKILL");
    }, heartbeatTimeoutMs);
    staleHeartbeatTimer.unref();
  }, "armStaleHeartbeatTimer");
  const launch = /* @__PURE__ */ __name(async (kind) => {
    clearStaleHeartbeatTimer();
    const argv = [
      opts.cliEntryPath,
      "channel",
      "daemon-worker",
      ...selectionChannelArgs(opts.selection)
    ];
    const env = createWorkerEnv({
      daemonUrl: opts.daemonUrl,
      workspace: opts.workspace,
      ...opts.daemonToken ? { daemonToken: opts.daemonToken } : {},
      ...opts.workerBaseEnv ? { baseEnv: opts.workerBaseEnv } : {},
      ...opts.tlsCaCertPath ? { tlsCaCertPath: opts.tlsCaCertPath } : {}
    });
    const promptAuthorization = env[CHANNEL_DAEMON_WORKER_SENTINEL];
    registerChannelWorkerPromptAuthorization(
      promptAuthorization,
      opts.workspace
    );
    activePromptAuthorization = promptAuthorization;
    const revokePromptAuthorization = /* @__PURE__ */ __name(() => {
      revokeChannelWorkerPromptAuthorization(promptAuthorization);
      if (activePromptAuthorization === promptAuthorization) {
        activePromptAuthorization = void 0;
      }
    }, "revokePromptAuthorization");
    const redaction = workerLogRedactionOptions(opts.daemonToken, env);
    const requestedChannels = requestedChannelNames(opts.selection);
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    snapshot = {
      enabled: true,
      state: "starting",
      channels: channelSelectionNames(opts.selection),
      ...requestedChannels ? { requestedChannels } : {},
      ...requestedChannels ? {
        adapters: requestedChannels.map((name) => ({
          name,
          state: "starting"
        }))
      } : {},
      startedAt,
      restartCount: snapshot.restartCount ?? 0,
      ...snapshot.lastExitAt ? { lastExitAt: snapshot.lastExitAt } : {},
      ...snapshot.lastHeartbeatAt ? { lastHeartbeatAt: snapshot.lastHeartbeatAt } : {},
      ...snapshot.staleHeartbeatAt ? { staleHeartbeatAt: snapshot.staleHeartbeatAt } : {}
    };
    if (kind === "restart") {
      const nowMs = Date.now();
      restartAttemptTimes.push(nowMs);
      snapshot = {
        ...snapshot,
        restartCount: (snapshot.restartCount ?? 0) + 1,
        lastRestartAt: new Date(nowMs).toISOString(),
        nextRestartAt: void 0
      };
    }
    let startedChild;
    try {
      startedChild = spawnWorker(process.execPath, argv, {
        cwd: opts.workspace,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
    } catch (err) {
      revokePromptAuthorization();
      const message = err instanceof Error ? err.message : String(err);
      const error = sanitizeWorkerError(message, redaction);
      if (kind === "initial") {
        snapshot = {
          ...snapshot,
          state: "failed",
          error
        };
        throw new Error(error);
      }
      handleRestartFailure(message, redaction);
      return;
    }
    child = startedChild;
    attachWorkerLogStream(startedChild.stdout, "stdout", {
      ...redaction,
      onLog: opts.onLog
    });
    attachWorkerLogStream(startedChild.stderr, "stderr", {
      ...redaction,
      onLog: opts.onLog
    });
    if (startedChild.pid !== void 0) {
      snapshot = { ...snapshot, pid: startedChild.pid };
    }
    const channelLoopMcpOwnerId = `channel-worker:${randomUUID()}`;
    const registeredChannelLoopMcpSessions = /* @__PURE__ */ new Set();
    const activeChannelLoopMcpControls = /* @__PURE__ */ new Set();
    const sendToStartedChild = /* @__PURE__ */ __name((message, callback) => {
      if (child !== startedChild || !startedChild.send) {
        throw new Error("Channel worker IPC is unavailable.");
      }
      return callback ? startedChild.send.call(startedChild, message, callback) : startedChild.send.call(startedChild, message);
    }, "sendToStartedChild");
    const sendChannelLoopMcpMessage = /* @__PURE__ */ __name((sessionId, payload) => {
      if (pendingChannelLoopMcpMessages.size >= MAX_CHANNEL_LOOP_MCP_IN_FLIGHT) {
        return Promise.reject(new Error("Channel loop MCP IPC queue is full."));
      }
      const message = createChannelLoopMcpRequest(sessionId, payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChannelLoopMcpMessages.delete(message.id);
          reject(new Error("Channel loop MCP IPC timed out."));
        }, CHANNEL_LOOP_MCP_IPC_TIMEOUT_MS);
        timer.unref();
        pendingChannelLoopMcpMessages.set(message.id, {
          resolve,
          reject,
          timer
        });
        try {
          sendToStartedChild(message, (error) => {
            if (!error) return;
            const pending = pendingChannelLoopMcpMessages.get(message.id);
            if (!pending) return;
            pendingChannelLoopMcpMessages.delete(message.id);
            clearTimeout(pending.timer);
            pending.reject(new Error("Channel loop MCP IPC send failed."));
          });
        } catch {
          const pending = pendingChannelLoopMcpMessages.get(message.id);
          if (!pending) return;
          pendingChannelLoopMcpMessages.delete(message.id);
          clearTimeout(pending.timer);
          pending.reject(new Error("Channel loop MCP IPC send failed."));
        }
      });
    }, "sendChannelLoopMcpMessage");
    const cleanupLaunchChannelLoopMcpRegistrations = /* @__PURE__ */ __name(() => {
      for (const sessionId of registeredChannelLoopMcpSessions) {
        void opts.unregisterChannelLoopMcp?.(sessionId, channelLoopMcpOwnerId).catch(() => {
        });
      }
      registeredChannelLoopMcpSessions.clear();
    }, "cleanupLaunchChannelLoopMcpRegistrations");
    cleanupChannelLoopMcpRegistrations = cleanupLaunchChannelLoopMcpRegistrations;
    await new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      let exitObserved = false;
      let terminatingBeforeReady = false;
      let startupTimer;
      const cleanupStartupTimer = /* @__PURE__ */ __name(() => {
        if (!startupTimer) return;
        clearTimeout(startupTimer);
        startupTimer = void 0;
      }, "cleanupStartupTimer");
      const cleanupLaunch = /* @__PURE__ */ __name(() => {
        cleanupStartupTimer();
        startedChild.removeListener("message", handleMessage);
        clearStaleHeartbeatTimer();
      }, "cleanupLaunch");
      const terminateBeforeReady = /* @__PURE__ */ __name(() => {
        cleanupLaunch();
        if (terminatingBeforeReady) return;
        terminatingBeforeReady = true;
        const exited = waitForExit(startedChild, CHANNEL_WORKER_KILL_GRACE_MS);
        startedChild.kill("SIGTERM");
        void exited.then(async (didExit) => {
          if (!didExit && child === startedChild && !exitObserved) {
            const killed = waitForExit(
              startedChild,
              CHANNEL_WORKER_KILL_GRACE_MS
            );
            startedChild.kill("SIGKILL");
            if (!await killed && child === startedChild && !exitObserved) {
              stopping = true;
              notifyLog(opts.onLog, {
                stream: "stderr",
                line: "Channel worker did not exit after SIGKILL; automatic restart is disabled."
              });
              snapshot = {
                ...snapshot,
                state: "failed",
                error: snapshot.error ?? "Channel worker did not exit after SIGKILL."
              };
              notifyExit(opts.onExit, snapshotCopy());
            }
          }
        });
      }, "terminateBeforeReady");
      const failBeforeReady = /* @__PURE__ */ __name((err) => {
        if (settled) return;
        settled = true;
        cleanupStartupTimer();
        if (kind === "initial") {
          reject(err);
        } else {
          resolve();
        }
      }, "failBeforeReady");
      const startupError = /* @__PURE__ */ __name((message) => {
        const failures = snapshot.startupFailures;
        return failures && failures.length > 0 ? new ChannelWorkerStartupError(message, {
          workspaceCwd: opts.workspace,
          startupFailures: failures,
          ...snapshot.startupFailuresTruncated ? { startupFailuresTruncated: true } : {}
        }) : new Error(message);
      }, "startupError");
      const failStartupProtocol = /* @__PURE__ */ __name((detail) => {
        if (settled || ready || child !== startedChild) return;
        const error = sanitizeWorkerError(
          `Channel worker startup IPC protocol error: ${detail}`,
          redaction
        );
        snapshot = { ...snapshot, state: "failed", error };
        failBeforeReady(startupError(error));
        terminateBeforeReady();
      }, "failStartupProtocol");
      const acknowledgeStartupReport = /* @__PURE__ */ __name(() => {
        const send = startedChild.send;
        if (!send) {
          failStartupProtocol("acknowledgement is unavailable.");
          return;
        }
        try {
          send.call(
            startedChild,
            { type: "channel_startup_report_ack" },
            (err) => {
              if (err) {
                failStartupProtocol("acknowledgement failed.");
              }
            }
          );
        } catch {
          failStartupProtocol("acknowledgement failed.");
        }
      }, "acknowledgeStartupReport");
      const handleStartupReport = /* @__PURE__ */ __name((message) => {
        if (!isChannelStartupReportMessage(message)) {
          failStartupProtocol("invalid startup report.");
          return;
        }
        if (message.type === "channel_startup_failures_truncated") {
          if (snapshot.startupFailuresTruncated || snapshot.startupFailures?.length !== MAX_CHANNEL_STARTUP_FAILURES) {
            failStartupProtocol("invalid truncation marker.");
            return;
          }
          snapshot = { ...snapshot, startupFailuresTruncated: true };
          acknowledgeStartupReport();
          return;
        }
        if (snapshot.startupFailuresTruncated || (snapshot.startupFailures?.length ?? 0) >= MAX_CHANNEL_STARTUP_FAILURES) {
          failStartupProtocol("too many startup failures.");
          return;
        }
        const safeChannel = sanitizeWorkerDiagnostic(
          message.failure.channel,
          MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
          redaction
        ) || "<unnamed>";
        const safeMessage = sanitizeWorkerDiagnostic(
          message.failure.message,
          MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
          redaction
        ) || "Channel connection failed.";
        const safeCode = message.failure.code ? sanitizeWorkerDiagnostic(
          message.failure.code,
          MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
          redaction
        ) : void 0;
        const failure = {
          channel: safeChannel,
          phase: "connect",
          ...safeCode ? { code: safeCode } : {},
          message: safeMessage
        };
        snapshot = {
          ...snapshot,
          startupFailures: [...snapshot.startupFailures ?? [], failure],
          adapters: snapshot.adapters?.map(
            (adapter) => adapter.name === failure.channel ? {
              name: adapter.name,
              state: "error",
              error: failure.message
            } : adapter
          )
        };
        acknowledgeStartupReport();
      }, "handleStartupReport");
      const completeReady = /* @__PURE__ */ __name((message) => {
        if (settled || child !== startedChild) return;
        settled = true;
        ready = true;
        cleanupStartupTimer();
        const next = {
          ...snapshot,
          state: "running",
          pid: message.pid ?? startedChild.pid,
          channels: message.channels && message.channels.length > 0 ? [...message.channels] : [...snapshot.channels]
        };
        delete next.error;
        delete next.lastHeartbeatAt;
        delete next.nextRestartAt;
        delete next.staleHeartbeatAt;
        if (message.requestedChannels?.length) {
          next.requestedChannels = [...message.requestedChannels];
        }
        const adapterNames = message.requestedChannels?.length ? message.requestedChannels : next.requestedChannels ?? next.channels;
        const connected = new Set(next.channels);
        const failures = new Map(
          next.startupFailures?.map((failure) => [failure.channel, failure])
        );
        next.adapters = adapterNames.map((name) => {
          if (connected.has(name)) {
            return { name, state: "connected" };
          }
          const failure = failures.get(name);
          return {
            name,
            state: "error",
            ...failure ? { error: failure.message } : {}
          };
        });
        snapshot = next;
        armStaleHeartbeatTimer(startedChild);
        notifyReady(opts.onReady, snapshotCopy());
        resolve();
      }, "completeReady");
      const handleHeartbeat = /* @__PURE__ */ __name((message) => {
        if (!ready || child !== startedChild) return;
        const currentPid = snapshot.pid ?? startedChild.pid;
        if (message.pid !== void 0 && currentPid !== void 0) {
          if (message.pid !== currentPid) return;
        }
        snapshot = {
          ...snapshot,
          lastHeartbeatAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        armStaleHeartbeatTimer(startedChild);
      }, "handleHeartbeat");
      const sendChannelLoopMcpControlResult = /* @__PURE__ */ __name((id, result) => {
        try {
          sendToStartedChild({
            type: "channel_loop_mcp_control_result",
            id,
            ...result
          });
        } catch {
        }
      }, "sendChannelLoopMcpControlResult");
      const handleChannelLoopMcpControl = /* @__PURE__ */ __name((message) => {
        if (activeChannelLoopMcpControls.size >= MAX_CHANNEL_LOOP_MCP_IN_FLIGHT) {
          sendChannelLoopMcpControlResult(message.id, {
            ok: false,
            error: "Channel loop MCP IPC queue is full."
          });
          return;
        }
        activeChannelLoopMcpControls.add(message.id);
        const operation = message.type === "channel_loop_mcp_register" ? opts.registerChannelLoopMcp?.({
          sessionId: message.sessionId,
          ownerId: channelLoopMcpOwnerId,
          sendMessage: /* @__PURE__ */ __name((payload) => sendChannelLoopMcpMessage(message.sessionId, payload), "sendMessage")
        }).then(async () => {
          if (child !== startedChild) {
            await opts.unregisterChannelLoopMcp?.(
              message.sessionId,
              channelLoopMcpOwnerId
            );
            throw new Error("Channel worker exited during MCP setup.");
          }
          registeredChannelLoopMcpSessions.add(message.sessionId);
        }) ?? Promise.reject(
          new Error("Channel loop MCP registration is unavailable.")
        ) : opts.unregisterChannelLoopMcp?.(
          message.sessionId,
          channelLoopMcpOwnerId
        ).then(() => {
          registeredChannelLoopMcpSessions.delete(message.sessionId);
        }) ?? Promise.resolve();
        void operation.then(() => {
          sendChannelLoopMcpControlResult(message.id, { ok: true });
        }).catch((error) => {
          sendChannelLoopMcpControlResult(message.id, {
            ok: false,
            error: sanitizeWorkerDiagnostic(
              error instanceof Error ? error.message : String(error),
              512,
              redaction
            ) || "Channel loop MCP operation failed."
          });
        }).finally(() => {
          activeChannelLoopMcpControls.delete(message.id);
        });
      }, "handleChannelLoopMcpControl");
      function handleMessage(message) {
        if (child !== startedChild) return;
        if (settleChannelDelivery(message)) {
          return;
        }
        if (settleWebhookTask(message)) {
          return;
        }
        if (settleChannelLoopMcpMessage(message)) {
          return;
        }
        if (isChannelLoopMcpControlMessage(message)) {
          handleChannelLoopMcpControl(message);
          return;
        }
        if (!ready && isChannelStartupReportType(message)) {
          handleStartupReport(message);
        } else if (!ready && isReadyMessage(message)) {
          completeReady(message);
        } else if (isHeartbeatMessage(message)) {
          handleHeartbeat(message);
        }
      }
      __name(handleMessage, "handleMessage");
      function settleExit(code, signal) {
        if (child !== startedChild) return;
        revokePromptAuthorization();
        exitObserved = true;
        cleanupLaunch();
        const state = ready ? "exited" : "failed";
        const message = `Channel worker exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
        setExited(
          state,
          code,
          signal,
          snapshot.error ?? (ready ? void 0 : sanitizeWorkerError(message, redaction))
        );
        rejectPendingWebhookTasks(
          "channel_worker_unavailable",
          "Channel worker exited."
        );
        rejectPendingChannelDeliveries(
          "channel_worker_unavailable",
          "Channel worker exited."
        );
        rejectPendingChannelLoopMcpMessages("Channel worker exited.");
        cleanupLaunchChannelLoopMcpRegistrations();
        if (cleanupChannelLoopMcpRegistrations === cleanupLaunchChannelLoopMcpRegistrations) {
          cleanupChannelLoopMcpRegistrations = void 0;
        }
        child = void 0;
        if ((ready || kind === "restart") && !stopping) {
          scheduleRestart();
          notifyExit(opts.onExit, snapshotCopy());
        }
        if (!settled) {
          failBeforeReady(startupError(snapshot.error ?? message));
        }
      }
      __name(settleExit, "settleExit");
      function settleError(err) {
        if (child !== startedChild || exitObserved) return;
        if (settled && ready) {
          snapshot = {
            ...snapshot,
            error: sanitizeWorkerError(err.message, redaction)
          };
          startedChild.kill("SIGTERM");
          return;
        }
        snapshot = {
          ...snapshot,
          state: "failed",
          error: sanitizeWorkerError(err.message, redaction)
        };
        terminateBeforeReady();
        if (!settled) {
          failBeforeReady(
            startupError(snapshot.error ?? "Channel worker failed to start.")
          );
        }
      }
      __name(settleError, "settleError");
      startupTimer = setTimeout(() => {
        const timeoutMs = opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS;
        const error = `Channel worker did not become ready within ${timeoutMs}ms.`;
        snapshot = {
          ...snapshot,
          state: "failed",
          error: sanitizeWorkerError(error, redaction)
        };
        failBeforeReady(startupError(error));
        if (child === startedChild) {
          terminateBeforeReady();
        }
      }, opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS);
      startupTimer.unref();
      startedChild.on("message", handleMessage);
      startedChild.once("exit", settleExit);
      startedChild.once("error", settleError);
    });
  }, "launch");
  const supervisor = {
    async start() {
      if (disposed) return;
      if (child) {
        if (stopping) {
          throw new ChannelWorkerStopError(
            "Channel worker stop is not yet confirmed."
          );
        }
        return;
      }
      stopping = false;
      clearRestartTimer();
      restartAttemptTimes = [];
      await launch("initial");
    },
    async stop() {
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      rejectPendingWebhookTasks(
        "channel_worker_unavailable",
        "Channel worker stopped."
      );
      rejectPendingChannelDeliveries(
        "channel_worker_unavailable",
        "Channel worker stopped."
      );
      rejectPendingChannelLoopMcpMessages("Channel worker stopped.");
      if (!child || snapshot.state === "exited" || snapshot.state === "failed" && hasObservedExit(snapshot) || snapshot.state === "stopped") {
        child = void 0;
        snapshot = { ...snapshot, state: "stopped" };
        return;
      }
      const stoppingChild = child;
      const exited = waitForExit(stoppingChild, CHANNEL_WORKER_STOP_GRACE_MS);
      stopping = true;
      stoppingChild.kill("SIGTERM");
      if (!await exited && child === stoppingChild) {
        const killed = waitForExit(stoppingChild, CHANNEL_WORKER_KILL_GRACE_MS);
        stoppingChild.kill("SIGKILL");
        if (!await killed) {
          snapshot = {
            ...snapshot,
            state: "failed",
            error: "Channel worker did not exit after SIGKILL."
          };
          throw new ChannelWorkerStopError();
        }
      }
      child = void 0;
      stopping = false;
      snapshot = { ...snapshot, state: "stopped" };
    },
    async restart() {
      if (disposed) return snapshotCopy();
      restarting ??= (async () => {
        try {
          await supervisor.stop();
          await supervisor.start();
          return snapshotCopy();
        } finally {
          restarting = void 0;
        }
      })();
      return restarting;
    },
    killAllSync() {
      disposed = true;
      rejectPendingWebhookTasks(
        "channel_worker_unavailable",
        "Channel worker stopped."
      );
      rejectPendingChannelDeliveries(
        "channel_worker_unavailable",
        "Channel worker stopped."
      );
      rejectPendingChannelLoopMcpMessages("Channel worker stopped.");
      cleanupChannelLoopMcpRegistrations?.();
      cleanupChannelLoopMcpRegistrations = void 0;
      if (!child || snapshot.state === "exited" || snapshot.state === "failed" && hasObservedExit(snapshot) || snapshot.state === "stopped") {
        clearRestartTimer();
        clearStaleHeartbeatTimer();
        return;
      }
      const preserveFailure = snapshot.state === "failed" && !hasObservedExit(snapshot);
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      stopping = true;
      if (activePromptAuthorization) {
        revokeChannelWorkerPromptAuthorization(activePromptAuthorization);
        activePromptAuthorization = void 0;
      }
      child.kill("SIGKILL");
      child = void 0;
      if (!preserveFailure) {
        snapshot = {
          ...snapshot,
          state: "stopped",
          signal: "SIGKILL"
        };
      }
    },
    snapshot() {
      return snapshotCopy();
    },
    async deliverChannelMessage(request) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== "running") {
        throw new ChannelDeliveryError(
          "channel_worker_unavailable",
          "Channel worker is not running."
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelDeliveryError(
          "channel_worker_unavailable",
          "Channel worker IPC send failed."
        );
      }
      if (pendingChannelDeliveries.size >= MAX_CHANNEL_DELIVERIES_IN_FLIGHT) {
        throw new ChannelDeliveryError(
          "channel_delivery_queue_full",
          "Channel delivery queue is full."
        );
      }
      const message = createChannelDeliveryMessage(request);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChannelDeliveries.delete(message.id);
          reject(
            new ChannelDeliveryError(
              "channel_delivery_timeout",
              "Channel delivery IPC timed out."
            )
          );
        }, CHANNEL_DELIVERY_IPC_TIMEOUT_MS);
        timer.unref();
        pendingChannelDeliveries.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (error) => {
            if (!error) return;
            rejectPendingChannelDelivery(
              message.id,
              new ChannelDeliveryError(
                "channel_worker_unavailable",
                `Channel worker IPC send failed: ${error.message}`
              )
            );
          });
        } catch (error) {
          rejectPendingChannelDelivery(
            message.id,
            new ChannelDeliveryError(
              "channel_worker_unavailable",
              `Channel worker IPC send failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
      });
    },
    async enqueueWebhookTask(task) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== "running") {
        throw new ChannelWebhookEnqueueError(
          "channel_worker_unavailable",
          "Channel worker is not running."
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelWebhookEnqueueError(
          "channel_worker_unavailable",
          "Channel worker IPC send failed."
        );
      }
      const message = createChannelWebhookTaskMessage(task);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWebhookTasks.delete(message.id);
          reject(
            new ChannelWebhookEnqueueError(
              "channel_webhook_enqueue_timeout",
              "Channel webhook task IPC timed out."
            )
          );
        }, CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS);
        timer.unref();
        pendingWebhookTasks.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (err) => {
            if (err) {
              rejectPendingWebhookTask(
                message.id,
                new ChannelWebhookEnqueueError(
                  "channel_worker_unavailable",
                  `Channel worker IPC send failed: ${err.message}`
                )
              );
            }
          });
        } catch (err) {
          rejectPendingWebhookTask(
            message.id,
            new ChannelWebhookEnqueueError(
              "channel_worker_unavailable",
              `Channel worker IPC send failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }
      });
    }
  };
  return supervisor;
}
__name(createChannelWorkerSupervisor, "createChannelWorkerSupervisor");

export {
  ExtraCaInspectionError,
  loadableCertificates,
  ChannelWorkerStopError,
  ChannelWorkerStartupError,
  cleanupMintedWorkerCaBundleDirs,
  resolveWorkerCaCertPath,
  createChannelWorkerSupervisor
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
