// Force strict mode and setup for ESM
"use strict";
import {
  computeCpuPercent
} from "./chunk-LBOVL47Y.js";
import {
  hostAssignsIpv6Loopback,
  isOwnInterfaceAddress
} from "./chunk-24FVUD5P.js";
import {
  RUNTIME_STARTUP_CANCELLED_MESSAGE
} from "./chunk-QUPXZXLV.js";
import {
  resolveRemoteServeToken
} from "./chunk-F23YN37B.js";
import {
  ACCESS_LOG_CONTROLLER_LOCAL,
  CAPABILITIES_SCHEMA_VERSION,
  ClientMcpSenderRegistry,
  PathMutexRegistry,
  SERVE_CAPABILITY_REGISTRY,
  ServeAppLifecycleController,
  WorkspaceVoiceCoordinator,
  acpChildExtraArgs,
  allowOriginCors,
  allowOriginMode,
  bearerAuth,
  createBridgeFileSystemAdapter,
  denyBrowserOriginCors,
  findNonLoopbackHttpOrigin,
  getAdvertisedServeFeatures,
  getDeviceFlowRegistry,
  getRateLimiter,
  getServeProtocolVersions,
  hostAllowlist,
  installRemoteSelfOriginMiddleware,
  installSelfOriginStripMiddleware,
  isBrowserAutomationMcpAvailable,
  isDeepHealthQuery,
  isLocalPathOpenAvailable,
  isLocalTerminalAvailable,
  isManagedScratchChild,
  isNativeDirectoryPickerAvailable,
  isSoftwareNetwork,
  isTrustedLoopbackMode,
  listLanCandidates,
  listenerMaxConnections,
  parseAllowOriginPatterns,
  parseDaemonStatusDetail,
  positiveFiniteOrNull,
  prepareManagedScratchRoot,
  resolveAcpHttpEnabled,
  toDaemonStatusMemoryLimits
} from "./chunk-YY273OSQ.js";
import {
  ConversationDirectoryIdentityError,
  assertExactConversationRootIdentity,
  createConversationRootIdentity,
  getConversationDirectoryName,
  getConversationStagedDirectoryName,
  inspectConversationDirectoryIdentity,
  inspectConversationStagedDirectoryIdentity,
  isSameConversationDirectoryObject,
  materializeConversationDirectoryIdentity,
  revalidateConversationRootIdentity
} from "./chunk-PB7JBAHF.js";
import {
  setDeferredRuntimeRequestTiming
} from "./chunk-LAUEEBDL.js";
import {
  formatHostForAuthority,
  isLoopbackAddress,
  isLoopbackBind
} from "./chunk-DMEUXLSS.js";
import {
  normalizeSessionIdForLookup
} from "./chunk-ZEZKIS2K.js";
import {
  require_express
} from "./chunk-PXBV45LZ.js";
import {
  resolveWebShellDir
} from "./chunk-FBX2SDQ4.js";
import "./chunk-NYWWQ437.js";
import {
  resolveSessionRestoreTimeoutMs
} from "./chunk-4JRM2BSM.js";
import {
  ConversationRuntimeOwnershipError,
  LIVE_HOST_PROTOCOL_VERSION
} from "./chunk-Y5TM7SBV.js";
import {
  DEFAULT_RING_SIZE
} from "./chunk-KWYTSSTJ.js";
import {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  DEFAULT_MAX_JOURNAL_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents
} from "./chunk-WCCLLK7X.js";
import {
  formatMemoryBudgetStderr,
  resolveDaemonMemoryBudget,
  serveJournalGrowthPoolMb
} from "./chunk-LYD3T3H7.js";
import {
  resolveChannelCwd
} from "./chunk-LFKXIOGC.js";
import {
  assertChannelControlWorkspaceCapacity
} from "./chunk-OTKRZOVK.js";
import {
  LOAD_REPLAY_META_KEY
} from "./chunk-RN6A53UJ.js";
import "./chunk-YXHY6BKS.js";
import "./chunk-ZL4HFSL6.js";
import "./chunk-K6KS3LTN.js";
import "./chunk-OSHQMOBS.js";
import {
  consumeServeFastPathRejectedLoaderKeys,
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides
} from "./chunk-YRNLF4SV.js";
import "./chunk-RO7OJQS2.js";
import {
  resolveMaxRegisteredWorkspaces,
  resolveWorkspaceInputs,
  workspaceRegistrationId
} from "./chunk-62ZLCVXZ.js";
import {
  canonicalizeWorkspace,
  translateAndCheckAbsoluteWorkspacePath
} from "./chunk-6PLDPT2C.js";
import {
  ExtraCaInspectionError,
  loadableCertificates
} from "./chunk-JH7CXRVS.js";
import "./chunk-FYJ7W2PI.js";
import "./chunk-Z7B6SRPM.js";
import {
  ChannelWebhookEnqueueError
} from "./chunk-STUJ7IMZ.js";
import {
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic
} from "./chunk-L3SNMEDW.js";
import {
  channelSelectionNames,
  normalizeServeChannelSelection
} from "./chunk-GDWE23OR.js";
import {
  QWEN_SERVER_TOKEN_ENV
} from "./chunk-GYTKQYDB.js";
import {
  ChannelDeliveryError,
  isChannelDeliveryError
} from "./chunk-RKFGE7JH.js";
import "./chunk-UDG5EZJI.js";
import {
  redactLogCredentials
} from "./chunk-M5GB774H.js";
import {
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV
} from "./chunk-3VUENPWF.js";
import {
  sanitizeLogText
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import {
  MAX_CHANNEL_CONTROL_WORKSPACES
} from "./chunk-CJ3DHN5I.js";
import "./chunk-BW4333PP.js";
import {
  getGlobalQwenDirLite,
  resolveConfigPathLite
} from "./chunk-IDS7MSUP.js";
import {
  acquireInheritedLoaderEnvScrub,
  clearLoaderKeyRejectionReporterIfCurrent,
  getEnvironmentBeforeLoad,
  scrubInheritedLoaderEnv,
  setLoaderKeyRejectionReporter
} from "./chunk-4VYTH6OF.js";
import {
  getCliVersion
} from "./chunk-GY7FOHQP.js";
import "./chunk-W3N5XAZ6.js";
import "./chunk-NPQ5ZKRP.js";
import {
  isWithinRoot
} from "./chunk-MR3PXB6E.js";
import "./chunk-GELRJXE2.js";
import {
  PRIVATE_CONVERSATIONS_RUNTIME_ENABLE,
  PRIVATE_CONVERSATIONS_RUNTIME_ENV
} from "./chunk-32CM56LO.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import "./chunk-XWRJCPHC.js";
import "./chunk-5ETULJLP.js";
import {
  MEMORY_PROJECT_SCOPES
} from "./chunk-HD7O6WLV.js";
import {
  TraceFlags,
  init_esm,
  isSpanContextValid,
  trace
} from "./chunk-TBWQLLFO.js";
import {
  finalizeStartupProfile,
  profileCheckpoint
} from "./chunk-QILD6R27.js";
import "./chunk-JVEGA3MM.js";
import {
  writeStderrLine,
  writeStdoutLine,
  writeStdoutLineSafe
} from "./chunk-7FA2II6K.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/run-qwen-serve.ts
init_esbuild_shims();
var import_express = __toESM(require_express(), 1);
import { X509Certificate, createHash as createHash2, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { monitorEventLoopDelay, performance as performance2 } from "node:perf_hooks";

// packages/acp-bridge/dist/child-heap-policy.js
init_esbuild_shims();

// packages/acp-bridge/dist/daemon-memory-budget.js
init_esbuild_shims();
var MIN_CHILD_HEAP_MB = 512;

// packages/acp-bridge/dist/child-heap-policy.js
var MAX_MODELED_ACP_CHILDREN = 25;
function createChildHeapPolicy(options) {
  const { budget, mode } = options;
  let refusals = 0;
  const admissible = Math.min(Math.floor(budget.childPoolMb / MIN_CHILD_HEAP_MB), MAX_MODELED_ACP_CHILDREN);
  const rawCeilingMb = admissible > 0 ? Math.min(Math.floor(budget.childPoolMb / admissible), budget.legacyChildCeilingMb) : null;
  const modelable = rawCeilingMb !== null && rawCeilingMb >= MIN_CHILD_HEAP_MB;
  const maxConcurrentChildren = modelable ? admissible : 0;
  const perChildCeilingMb = modelable ? rawCeilingMb : null;
  if (mode === "admit" && maxConcurrentChildren === 0) {
    throw new TypeError("ACP admission requires a memory budget that models at least one child.");
  }
  return {
    decide(concurrentChildren) {
      if (mode === "off")
        return { refuse: false };
      const refuse = concurrentChildren > maxConcurrentChildren;
      if (refuse)
        refusals += 1;
      return { refuse };
    },
    snapshot() {
      const modeled = mode !== "off";
      return {
        mode,
        childPoolMb: budget.childPoolMb,
        minChildHeapMb: MIN_CHILD_HEAP_MB,
        maxConcurrentChildren: modeled ? maxConcurrentChildren : null,
        perChildCeilingMb: modeled ? perChildCeilingMb : null,
        refusals
      };
    }
  };
}
__name(createChildHeapPolicy, "createChildHeapPolicy");

// packages/cli/src/serve/remote-quickstart.ts
init_esbuild_shims();
import { networkInterfaces } from "node:os";
function isUlaIpv6(address) {
  return /^(?:fc|fd)/iu.test(address);
}
__name(isUlaIpv6, "isUlaIpv6");
function isLinkLocalIpv4(address) {
  return address.startsWith("169.254.");
}
__name(isLinkLocalIpv4, "isLinkLocalIpv4");
function quickstartPrintMode(boundAddress, generated) {
  if (!isLoopbackAddress(boundAddress)) return "full";
  return generated ? "token-only" : "silent";
}
__name(quickstartPrintMode, "quickstartPrintMode");
function remoteQuickstartEntries(bind, boundAddress, port, tls, interfaces) {
  const scheme = tls ? "https" : "http";
  const url = /* @__PURE__ */ __name((host) => `${scheme}://${formatHostForAuthority(host)}:${port}`, "url");
  const bound = boundAddress.trim().toLowerCase();
  const ipv4Wildcard = bound === "0.0.0.0" || bound === "::ffff:0.0.0.0";
  if (!ipv4Wildcard && bound !== "::") {
    if (bind.trim().includes("%")) return [];
    return [{ label: "Address", url: url(bind), address: bind }];
  }
  const localAddress = !ipv4Wildcard && hostAssignsIpv6Loopback(interfaces) ? "::1" : "127.0.0.1";
  const addresses = [
    { label: "Local", url: url(localAddress), address: localAddress }
  ];
  for (const candidate of listLanCandidates(interfaces)) {
    addresses.push({
      label: `Network (${candidate.interfaceName})`,
      url: url(candidate.address),
      address: candidate.address
    });
  }
  if (!ipv4Wildcard) {
    for (const [name, entries] of Object.entries(interfaces).sort()) {
      if (isSoftwareNetwork(name)) continue;
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== "IPv6") continue;
        if (entry.address.includes("%") || !isUlaIpv6(entry.address)) continue;
        addresses.push({
          label: `Network (${name})`,
          url: url(entry.address),
          address: entry.address
        });
      }
    }
  }
  return addresses;
}
__name(remoteQuickstartEntries, "remoteQuickstartEntries");
async function printRemoteQuickstart(input) {
  try {
    const mode = quickstartPrintMode(input.boundAddress, input.generated);
    if (mode === "silent") return;
    if (mode === "token-only") {
      writeStdoutLineSafe(
        `Generated bearer token (secret; changes on restart): ${input.token}`
      );
      writeStdoutLineSafe(
        "The listener bound loopback, so no network address or QR is printed; local clients must present this bearer."
      );
      return;
    }
    const addresses = remoteQuickstartEntries(
      input.bind,
      input.boundAddress,
      input.port,
      input.tls,
      input.interfaces ?? networkInterfaces()
    );
    for (const address of addresses)
      writeStdoutLineSafe(`${address.label}: ${address.url}`);
    if (input.generated) {
      writeStdoutLineSafe(
        `Generated bearer token (secret; changes on restart): ${input.token}`
      );
    }
    if (!input.tls)
      writeStdoutLineSafe(
        "HTTP is unencrypted. Use the existing TLS options for encrypted remote access."
      );
    if (!input.web) return;
    const candidate = addresses.find(
      (address) => address.label !== "Local" && !isLinkLocalIpv4(address.address)
    ) ?? addresses.find((address) => address.label !== "Local");
    if (!candidate) {
      writeStdoutLineSafe(
        "QR unavailable; enter the bearer token at the daemon address."
      );
      return;
    }
    if (!input.generated && !process.stdout.isTTY) return;
    try {
      const { default: qrcode } = await import("./main-PXAUXNF2.js");
      qrcode.setErrorLevel("Q");
      qrcode.generate(
        `${candidate.url}/#token=${encodeURIComponent(input.token)}`,
        { small: true },
        (code) => {
          writeStdoutLineSafe(
            `Scan to open Web Shell: ${candidate.url} (${candidate.label})`
          );
          writeStdoutLineSafe("SECRET QR: grants daemon access. Do not share.");
          writeStdoutLineSafe(code.trimEnd());
        }
      );
    } catch {
      writeStdoutLineSafe(
        "QR unavailable; enter the bearer token at the daemon address."
      );
    }
  } catch {
  }
}
__name(printRemoteQuickstart, "printRemoteQuickstart");

// packages/cli/src/serve/permission-audit.ts
init_esbuild_shims();
var DEFAULT_PERMISSION_AUDIT_RING_SIZE = 512;
function takeLast(arr, limit, methodName) {
  if (limit === void 0) return arr.slice();
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `${methodName} limit must be a non-negative integer; got ${String(limit)}`
    );
  }
  return arr.slice(Math.max(0, arr.length - limit));
}
__name(takeLast, "takeLast");
var PermissionAuditRing = class {
  static {
    __name(this, "PermissionAuditRing");
  }
  buf = [];
  cap;
  constructor(capacity = DEFAULT_PERMISSION_AUDIT_RING_SIZE) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `PermissionAuditRing capacity must be a positive integer; got ${String(capacity)}`
      );
    }
    this.cap = capacity;
  }
  push(entry) {
    this.buf.push(entry);
    while (this.buf.length > this.cap) this.buf.shift();
  }
  /** Snapshot the most-recent `limit` entries (or all if omitted). */
  snapshot(limit) {
    return takeLast(this.buf, limit, "PermissionAuditRing.snapshot");
  }
  /** Subset filtered by sessionId. */
  snapshotForSession(sessionId, limit) {
    return takeLast(
      this.buf.filter((e) => e.sessionId === sessionId),
      limit,
      "PermissionAuditRing.snapshotForSession"
    );
  }
  /** Current entry count (≤ capacity). For diagnostics. */
  get size() {
    return this.buf.length;
  }
  /** Configured capacity. */
  get capacity() {
    return this.cap;
  }
};
function createPermissionAuditPublisher(deps) {
  const { ring } = deps;
  const now = deps.now ?? (() => Date.now());
  return {
    recordRequested(record, policy, votersAtIssue) {
      ring.push({
        kind: "permission.requested",
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        originatorClientId: record.originatorClientId,
        policy,
        votersAtIssue: Array.from(votersAtIssue),
        issuedAtMs: record.issuedAtMs,
        allowedOptionIds: Array.from(record.allowedOptionIds)
      });
    },
    recordVoted(record, vote, outcome) {
      ring.push({
        kind: "permission.voted",
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        clientId: vote.clientId,
        optionId: vote.optionId,
        fromLoopback: vote.fromLoopback,
        receivedAtMs: vote.receivedAtMs,
        outcome
      });
    },
    recordForbidden(record, vote, reason) {
      ring.push({
        kind: "permission.forbidden",
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        clientId: vote.clientId,
        optionId: vote.optionId,
        fromLoopback: vote.fromLoopback,
        reason
      });
    },
    recordResolved(record, resolution, decisionReason) {
      ring.push({
        kind: "permission.resolved",
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        resolution,
        decisionReason
      });
    },
    recordTimeout(record) {
      ring.push({
        kind: "permission.timeout",
        recordedAtMs: now(),
        requestId: record.requestId,
        sessionId: record.sessionId,
        issuedAtMs: record.issuedAtMs
      });
    }
  };
}
__name(createPermissionAuditPublisher, "createPermissionAuditPublisher");

// packages/cli/src/serve/daemon-logger.ts
init_esbuild_shims();
init_esm();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
var FIXED_CTX_ORDER = [
  "route",
  "sessionId",
  "clientId",
  "childPid",
  "channelId"
];
var FIXED_CTX_SET = new Set(FIXED_CTX_ORDER);
var RESERVED_TRACE_CTX_KEYS = /* @__PURE__ */ new Set([
  "trace_id",
  "span_id"
]);
var ISSUE_ORDER = [
  "init_failed",
  "rotation_failed",
  "retention_failed",
  "queue_overflow",
  "write_failed",
  "lease_compromised"
];
var DEFAULT_POLICY = {
  maxBytes: 10 * 1024 * 1024,
  maxArchives: 4,
  maxRecordBytes: 256 * 1024,
  maxPendingBytes: 4 * 1024 * 1024,
  stableAcquireBudgetMs: 1e3,
  maintenanceAcquireBudgetMs: 250,
  lockStaleMs: 6e4,
  lockUpdateMs: 1e4,
  rotationRetryIntervalMs: 6e4,
  closeDrainBudgetMs: 2e3
};
var ARCHIVE_RE = /^daemon-(\d{12})-(\d{8}T\d{9}Z)-([0-9a-f]{8})\.log$/;
var FALLBACK_DIR_RE = /^run-[0-9a-f]{32}$/;
var ARCHIVE_NAME_ATTEMPTS = 3;
var FILE_MODE = 384;
var DIRECTORY_MODE = 448;
function renderCtxValue(value) {
  const s = String(value);
  return /[\s=]/.test(s) ? JSON.stringify(s) : s;
}
__name(renderCtxValue, "renderCtxValue");
function renderCtx(ctx) {
  if (!ctx) return "";
  const parts = [];
  for (const key of FIXED_CTX_ORDER) {
    const v = ctx[key];
    if (v !== void 0 && v !== null) {
      parts.push(`${key}=${String(v)}`);
    }
  }
  const extraKeys = Object.keys(ctx).filter(
    (key) => !FIXED_CTX_SET.has(key) && !RESERVED_TRACE_CTX_KEYS.has(key) && ctx[key] !== void 0 && ctx[key] !== null
  ).sort();
  for (const key of extraKeys) {
    parts.push(`${key}=${renderCtxValue(ctx[key])}`);
  }
  return parts.length > 0 ? parts.join(" ") + " " : "";
}
__name(renderCtx, "renderCtx");
function getActiveTraceContext() {
  try {
    const span = trace.getActiveSpan();
    if (!span?.isRecording()) return void 0;
    const spanContext = span.spanContext();
    if (!isSpanContextValid(spanContext) || (spanContext.traceFlags & TraceFlags.SAMPLED) === 0) {
      return void 0;
    }
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId
    };
  } catch {
    return void 0;
  }
}
__name(getActiveTraceContext, "getActiveTraceContext");
function renderTraceContext(traceContext) {
  return traceContext ? `[trace_id=${traceContext.traceId} span_id=${traceContext.spanId}] ` : "";
}
__name(renderTraceContext, "renderTraceContext");
function renderErr(err) {
  if (!err) return "";
  const body = err.stack ?? `${err.name ?? "Error"}: ${err.message}`;
  return body.split("\n").map((line) => `  ${line}`).join("\n") + "\n";
}
__name(renderErr, "renderErr");
function formatDaemonLogLine(args) {
  const ts = args.now.toISOString();
  const traceStr = renderTraceContext(args.traceContext);
  const ctxStr = renderCtx(args.ctx);
  return `${ts} [${args.level}] [DAEMON] ${traceStr}${ctxStr}${args.message}
${renderErr(args.err)}`;
}
__name(formatDaemonLogLine, "formatDaemonLogLine");
function buildDaemonFileLogLine(args, runId, pid) {
  const callerCtx = args.ctx ? Object.fromEntries(
    Object.entries(args.ctx).filter(
      ([key]) => key !== "runId" && key !== "pid"
    )
  ) : void 0;
  const traceStr = renderTraceContext(args.traceContext);
  const ctxStr = renderCtx(callerCtx);
  return `${args.now.toISOString()} [${args.level}] [DAEMON] runId=${runId} pid=${pid} ${traceStr}${ctxStr}${args.message}
${renderErr(args.err)}`;
}
__name(buildDaemonFileLogLine, "buildDaemonFileLogLine");
function getRuntimeBaseDir(runtimeOutputDir, cwd) {
  const envDir = process.env["QWEN_RUNTIME_DIR"];
  if (envDir) return resolveConfigPathLite(envDir);
  if (runtimeOutputDir) return resolveConfigPathLite(runtimeOutputDir, cwd);
  return getGlobalQwenDirLite();
}
__name(getRuntimeBaseDir, "getRuntimeBaseDir");
function resolveDaemonLogBaseDir(runtimeOutputDir, cwd) {
  return nodePath.join(getRuntimeBaseDir(runtimeOutputDir, cwd), "debug");
}
__name(resolveDaemonLogBaseDir, "resolveDaemonLogBaseDir");
function isOptedOut() {
  const raw = process.env["QWEN_DAEMON_LOG_FILE"];
  if (!raw) return false;
  return ["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}
__name(isOptedOut, "isOptedOut");
function computeWorkspaceHash(boundWorkspace) {
  return crypto.createHash("sha256").update(boundWorkspace).digest("hex").slice(0, 8);
}
__name(computeWorkspaceHash, "computeWorkspaceHash");
function computeDaemonId(pid) {
  return `daemon:${pid}`;
}
__name(computeDaemonId, "computeDaemonId");
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
__name(isErrno, "isErrno");
function resolvePolicy(overrides) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid daemon logger policy ${name}=${value}`);
    }
  }
  if (policy.maxBytes === 0 || policy.maxArchives === 0 || policy.maxRecordBytes === 0 || policy.maxPendingBytes === 0) {
    throw new TypeError(
      "Daemon logger size/count policy values must be positive"
    );
  }
  if (policy.maxRecordBytes > policy.maxBytes) {
    throw new TypeError(
      "Daemon logger maxRecordBytes must not exceed maxBytes"
    );
  }
  if (policy.maxRecordBytes > policy.maxPendingBytes) {
    throw new TypeError(
      "Daemon logger maxRecordBytes must not exceed maxPendingBytes"
    );
  }
  return policy;
}
__name(resolvePolicy, "resolvePolicy");
function statusSnapshot(runId, mode, issues, droppedRecords, droppedBytes) {
  return {
    runId,
    mode,
    health: issues.size === 0 ? "ok" : "degraded",
    issues: ISSUE_ORDER.filter((issue) => issues.has(issue)),
    droppedRecords,
    droppedBytes
  };
}
__name(statusSnapshot, "statusSnapshot");
function createStderrOnlyLogger(input) {
  const tee = /* @__PURE__ */ __name((level, message, ctx, err) => {
    const traceContext = getActiveTraceContext();
    input.stderr(
      formatDaemonLogLine({
        level,
        message,
        now: input.now(),
        ctx,
        err,
        traceContext
      }).trimEnd()
    );
  }, "tee");
  return {
    info: /* @__PURE__ */ __name((message, ctx) => tee("INFO", message, ctx), "info"),
    warn: /* @__PURE__ */ __name((message, ctx) => tee("WARN", message, ctx), "warn"),
    error: /* @__PURE__ */ __name((message, err, ctx) => tee("ERROR", message, ctx, err ?? void 0), "error"),
    raw: /* @__PURE__ */ __name(() => {
    }, "raw"),
    getLogPath: /* @__PURE__ */ __name(() => "", "getLogPath"),
    getDaemonId: /* @__PURE__ */ __name(() => input.daemonId, "getDaemonId"),
    getStatus: /* @__PURE__ */ __name(() => statusSnapshot(input.runId, "stderr-only", input.issues, 0, 0), "getStatus"),
    flush: /* @__PURE__ */ __name(() => Promise.resolve(), "flush"),
    close: /* @__PURE__ */ __name(() => Promise.resolve(), "close")
  };
}
__name(createStderrOnlyLogger, "createStderrOnlyLogger");
function capUtf8Record(record, maxBytes) {
  const bytes = Buffer.from(record, "utf8");
  if (bytes.length <= maxBytes) return record;
  const marker = `
[truncated originalBytes=${bytes.length}]
`;
  const markerBytes = Buffer.from(marker, "utf8");
  if (markerBytes.length >= maxBytes) {
    return Buffer.from("[truncated]\n", "utf8").subarray(0, maxBytes).toString("utf8");
  }
  let prefixBytes = maxBytes - markerBytes.length;
  while (prefixBytes > 0 && (bytes[prefixBytes] & 192) === 128) {
    prefixBytes -= 1;
  }
  return bytes.subarray(0, prefixBytes).toString("utf8") + marker;
}
__name(capUtf8Record, "capUtf8Record");
async function ensureRealDirectory(fs2, dirPath, mutationAllowed = () => true) {
  try {
    const existing = await fs2.lstat(dirPath);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`${dirPath} is not a real directory`);
    }
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if (!mutationAllowed()) {
    throw new Error(`File mutation is no longer allowed for ${dirPath}`);
  }
  await fs2.mkdir(dirPath, { recursive: true, mode: DIRECTORY_MODE });
  const created = await fs2.lstat(dirPath);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`${dirPath} is not a real directory`);
  }
}
__name(ensureRealDirectory, "ensureRealDirectory");
async function activeFileSize(fs2, activePath) {
  try {
    const stat2 = await fs2.lstat(activePath);
    if (!stat2.isFile() || stat2.isSymbolicLink()) {
      throw new Error(`${activePath} is not a regular file`);
    }
    return stat2.size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    throw error;
  }
}
__name(activeFileSize, "activeFileSize");
async function lastByteIsNewline(fs2, activePath, size) {
  if (size === 0) return true;
  const handle = await fs2.open(activePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1);
    const result = await handle.read(buffer, 0, 1, size - 1);
    return result.bytesRead === 1 && buffer[0] === 10;
  } finally {
    await handle.close();
  }
}
__name(lastByteIsNewline, "lastByteIsNewline");
function archiveTimestamp(now) {
  return now.toISOString().replace(/[-:.]/g, "");
}
__name(archiveTimestamp, "archiveTimestamp");
async function scanArchives(fs2, archiveDir) {
  const entries = await fs2.readdir(archiveDir, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ARCHIVE_RE.exec(entry.name);
    if (!match) continue;
    archives.push({ name: entry.name, generation: Number(match[1]) });
  }
  archives.sort(
    (a, b) => a.generation - b.generation || a.name.localeCompare(b.name)
  );
  return archives;
}
__name(scanArchives, "scanArchives");
function lockRetries(maxRetryTime) {
  if (maxRetryTime <= 0) return 0;
  return {
    retries: 4,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 400,
    randomize: true,
    maxRetryTime
  };
}
__name(lockRetries, "lockRetries");
async function acquireLease(input) {
  const lease = {
    compromised: false,
    released: false,
    release: /* @__PURE__ */ __name(async () => {
    }, "release")
  };
  const release = await input.acquireLock(input.targetPath, {
    lockfilePath: input.lockPath,
    realpath: true,
    stale: input.policy.lockStaleMs,
    update: input.policy.lockUpdateMs,
    retries: lockRetries(input.retryBudgetMs),
    onCompromised: /* @__PURE__ */ __name((error) => {
      if (lease.released) return;
      lease.compromised = true;
      try {
        input.onCompromised?.(error);
      } catch {
      }
    }, "onCompromised")
  });
  try {
    if (lease.compromised) {
      throw new Error(
        `Lease was compromised while acquiring ${input.lockPath}`
      );
    }
    await input.fs.chmod(input.lockPath, DIRECTORY_MODE);
  } catch (error) {
    lease.released = true;
    await release().catch(() => {
    });
    throw error;
  }
  lease.release = async () => {
    if (lease.released) return;
    lease.released = true;
    await release();
  };
  return lease;
}
__name(acquireLease, "acquireLease");
async function updateLatestBestEffort(fs2, daemonDir, targetPath, mutationAllowed) {
  const linkPath = nodePath.join(daemonDir, "latest");
  if (!mutationAllowed()) return;
  try {
    await fs2.unlink(linkPath);
  } catch {
  }
  if (!mutationAllowed()) return;
  try {
    await fs2.symlink(nodePath.relative(daemonDir, targetPath), linkPath);
  } catch {
  }
}
__name(updateLatestBestEffort, "updateLatestBestEffort");
async function readRecentFallback(fs2, runsDir) {
  try {
    const raw = await fs2.readFile(
      nodePath.join(runsDir, "recent-fallback"),
      "utf8"
    );
    const name = raw.trim();
    return FALLBACK_DIR_RE.test(name) ? name : void 0;
  } catch {
    return void 0;
  }
}
__name(readRecentFallback, "readRecentFallback");
async function writeRecentFallback(fs2, runsDir, name, mutationAllowed = () => true) {
  const locatorPath = nodePath.join(runsDir, "recent-fallback");
  if (!name) {
    if (!mutationAllowed()) {
      throw new Error("Fallback locator mutation is no longer allowed");
    }
    try {
      await fs2.unlink(locatorPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return;
  }
  if (!FALLBACK_DIR_RE.test(name)) {
    throw new Error(`Invalid fallback locator target: ${name}`);
  }
  const tempPath = nodePath.join(runsDir, ".recent-fallback.tmp");
  try {
    const tempStat = await fs2.lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      throw new Error(`${tempPath} is not a regular file`);
    }
    if (!mutationAllowed()) {
      throw new Error("Fallback locator mutation is no longer allowed");
    }
    await fs2.unlink(tempPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if (!mutationAllowed()) {
    throw new Error("Fallback locator mutation is no longer allowed");
  }
  await fs2.writeFile(tempPath, `${name}
`, {
    encoding: "utf8",
    mode: FILE_MODE,
    flag: "wx"
  });
  if (!mutationAllowed()) {
    throw new Error("Fallback locator mutation is no longer allowed");
  }
  await fs2.rename(tempPath, locatorPath);
}
__name(writeRecentFallback, "writeRecentFallback");
async function listFallbackDirectories(fs2, runsDir) {
  const entries = await fs2.readdir(runsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && FALLBACK_DIR_RE.test(entry.name)).map((entry) => entry.name).sort();
}
__name(listFallbackDirectories, "listFallbackDirectories");
async function fallbackActivityMtime(fs2, familyDir) {
  try {
    return (await fs2.lstat(nodePath.join(familyDir, "daemon.log"))).mtimeMs;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return (await fs2.lstat(familyDir)).mtimeMs;
  }
}
__name(fallbackActivityMtime, "fallbackActivityMtime");
async function cleanupFallbackFamilies(input) {
  const mutationAllowed = input.mutationAllowed ?? (() => true);
  const locator = await readRecentFallback(input.fs, input.runsDir);
  const names = await listFallbackDirectories(input.fs, input.runsDir);
  const live = /* @__PURE__ */ new Set();
  const inactive = [];
  try {
    for (const name of names) {
      if (!mutationAllowed()) {
        throw new Error("Fallback cleanup lease was compromised");
      }
      const familyDir = nodePath.join(input.runsDir, name);
      let lease;
      try {
        lease = await acquireLease({
          fs: input.fs,
          acquireLock: input.acquireLock,
          targetPath: familyDir,
          lockPath: nodePath.join(familyDir, ".owner.lock"),
          policy: input.policy,
          retryBudgetMs: 0
        });
        if (!mutationAllowed()) {
          throw new Error("Fallback cleanup lease was compromised");
        }
        if (lease.compromised) {
          await lease.release().catch(() => {
          });
          throw new Error(`Fallback owner lease was compromised: ${familyDir}`);
        }
        inactive.push({
          name,
          mtimeMs: await fallbackActivityMtime(input.fs, familyDir),
          lease
        });
      } catch (error) {
        await lease?.release().catch(() => {
        });
        if (isErrno(error, "ELOCKED")) {
          live.add(name);
          continue;
        }
        throw error;
      }
    }
    const inactiveNames = new Set(inactive.map((entry) => entry.name));
    const retainedInactive = (input.preferredInactive && inactiveNames.has(input.preferredInactive) ? input.preferredInactive : void 0) ?? (locator && inactiveNames.has(locator) ? locator : void 0) ?? inactive.slice().sort(
      (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)
    )[0]?.name;
    for (const entry of inactive) {
      await entry.lease.release();
      if (entry.name === retainedInactive) continue;
      if (!mutationAllowed()) {
        throw new Error("Fallback cleanup lease was compromised");
      }
      await input.fs.rm(nodePath.join(input.runsDir, entry.name), {
        recursive: true,
        force: true
      });
    }
    const remaining = [...live, ...retainedInactive ? [retainedInactive] : []].filter((name, index, all) => all.indexOf(name) === index).sort();
    const nextLocator = retainedInactive ?? (locator && remaining.includes(locator) ? locator : remaining.at(-1));
    if (locator !== nextLocator) {
      await writeRecentFallback(
        input.fs,
        input.runsDir,
        nextLocator,
        mutationAllowed
      ).catch(() => {
      });
    }
  } finally {
    await Promise.all(
      inactive.filter((entry) => !entry.lease.released).map((entry) => entry.lease.release().catch(() => {
      }))
    );
  }
}
__name(cleanupFallbackFamilies, "cleanupFallbackFamilies");
async function acquireMaintenanceLease(input) {
  await ensureRealDirectory(input.fs, input.runsDir);
  return acquireLease({
    fs: input.fs,
    acquireLock: input.acquireLock,
    targetPath: input.runsDir,
    lockPath: nodePath.join(input.runsDir, ".maintenance.lock"),
    policy: input.policy,
    retryBudgetMs: input.retryBudgetMs
  });
}
__name(acquireMaintenanceLease, "acquireMaintenanceLease");
async function allocateFallbackFamily(input) {
  const runsDir = nodePath.join(input.daemonDir, "runs");
  const maintenance = await acquireMaintenanceLease({
    ...input,
    runsDir,
    retryBudgetMs: input.policy.maintenanceAcquireBudgetMs
  });
  let familyDir;
  let familyCreated = false;
  let lease;
  const maintenanceAllowsMutation = /* @__PURE__ */ __name(() => !maintenance.compromised && !maintenance.released, "maintenanceAllowsMutation");
  try {
    if (!maintenanceAllowsMutation()) {
      throw new Error("Fallback maintenance lease was compromised");
    }
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      mutationAllowed: maintenanceAllowsMutation
    });
    if (!maintenanceAllowsMutation()) {
      throw new Error("Fallback maintenance lease was compromised");
    }
    const name = `run-${input.runId}`;
    familyDir = nodePath.join(runsDir, name);
    await input.fs.mkdir(familyDir, { mode: DIRECTORY_MODE });
    familyCreated = true;
    if (!maintenanceAllowsMutation()) {
      throw new Error("Fallback maintenance lease was compromised");
    }
    lease = await acquireLease({
      fs: input.fs,
      acquireLock: input.acquireLock,
      targetPath: familyDir,
      lockPath: nodePath.join(familyDir, ".owner.lock"),
      policy: input.policy,
      retryBudgetMs: 0,
      onCompromised: input.onCompromised
    });
    if (!maintenanceAllowsMutation()) {
      throw new Error("Fallback maintenance lease was compromised");
    }
  } catch (error) {
    await lease?.release().catch(() => {
    });
    if (familyCreated && familyDir && maintenanceAllowsMutation()) {
      await input.fs.rm(familyDir, { recursive: true, force: true }).catch(() => {
      });
    }
    await maintenance.release().catch(() => {
    });
    throw error;
  }
  try {
    await maintenance.release();
  } catch (error) {
    await lease.release().catch(() => {
    });
    throw error;
  }
  return {
    mode: "fallback",
    activePath: nodePath.join(familyDir, "daemon.log"),
    archiveDir: nodePath.join(familyDir, "archive"),
    familyDir,
    lease,
    releaseLease: lease.release
  };
}
__name(allocateFallbackFamily, "allocateFallbackFamily");
async function removeFailedFallbackBestEffort(input) {
  if (input.family.lease.compromised) {
    await input.family.releaseLease().catch(() => {
    });
    return;
  }
  const runsDir = nodePath.dirname(input.family.familyDir);
  let maintenance;
  try {
    maintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0
    });
  } catch {
    await input.family.releaseLease().catch(() => {
    });
    return;
  }
  try {
    if (maintenance.compromised) {
      await input.family.releaseLease().catch(() => {
      });
      return;
    }
    try {
      await input.family.releaseLease();
    } catch {
      return;
    }
    if (maintenance.compromised || input.family.lease.compromised) return;
    await input.fs.rm(input.family.familyDir, { recursive: true, force: true }).catch(() => {
    });
  } finally {
    await maintenance.release().catch(() => {
    });
  }
}
__name(removeFailedFallbackBestEffort, "removeFailedFallbackBestEffort");
async function closeFallbackFamily(input) {
  if (input.family.lease.compromised) {
    await input.family.releaseLease().catch(() => {
    });
    return;
  }
  const runsDir = nodePath.dirname(input.family.familyDir);
  let maintenance;
  try {
    maintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0
    });
  } catch {
    await input.family.releaseLease().catch(input.onRetentionError);
    return;
  }
  try {
    if (maintenance.compromised) {
      throw new Error("Fallback maintenance lease was compromised");
    }
    await input.family.releaseLease();
    const name = nodePath.basename(input.family.familyDir);
    const mutationAllowed = /* @__PURE__ */ __name(() => !maintenance.compromised && !input.family.lease.compromised, "mutationAllowed");
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      preferredInactive: name,
      mutationAllowed
    });
    await writeRecentFallback(input.fs, runsDir, name, mutationAllowed);
  } catch (error) {
    await input.family.releaseLease().catch(input.onRetentionError);
    input.onRetentionError(error);
  } finally {
    await maintenance.release().catch(input.onRetentionError);
  }
}
__name(closeFallbackFamily, "closeFallbackFamily");
async function cleanupFallbacksBestEffort(input) {
  const runsDir = nodePath.join(input.daemonDir, "runs");
  try {
    const stat2 = await input.fs.lstat(runsDir);
    if (!stat2.isDirectory() || stat2.isSymbolicLink()) {
      throw new Error(`${runsDir} is not a real directory`);
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    input.onRetentionError(error);
    return;
  }
  let maintenance;
  try {
    const currentMaintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0
    });
    maintenance = currentMaintenance;
    const mutationAllowed = /* @__PURE__ */ __name(() => !currentMaintenance.compromised && !currentMaintenance.released && (input.mutationAllowed?.() ?? true), "mutationAllowed");
    if (!mutationAllowed()) {
      throw new Error("Fallback maintenance lease was compromised");
    }
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      mutationAllowed
    });
  } catch (error) {
    if (!isErrno(error, "ELOCKED")) input.onRetentionError(error);
  } finally {
    await maintenance?.release().catch(input.onRetentionError);
  }
}
__name(cleanupFallbacksBestEffort, "cleanupFallbacksBestEffort");
function createConcreteLogger(input) {
  let pending = Promise.resolve();
  let pendingBytes = 0;
  let droppedRecords = 0;
  let droppedBytes = 0;
  let reportedDroppedRecords = 0;
  let reportedDroppedBytes = 0;
  let overflowEpisode = false;
  let dropSummaryPending = false;
  let acceptingFileRecords = true;
  let closePromise;
  const markDropped = /* @__PURE__ */ __name((bytes, queueOverflow = false) => {
    droppedRecords += 1;
    droppedBytes += bytes;
    if (queueOverflow) {
      input.issues.add("queue_overflow");
      if (!overflowEpisode) {
        overflowEpisode = true;
        input.stderr(
          "qwen serve: daemon log queue limit reached; dropping file copies until capacity recovers"
        );
      }
    }
  }, "markDropped");
  const markRotationFailure = /* @__PURE__ */ __name((message, error) => {
    input.issues.add("rotation_failed");
    input.state.nextRotationRetryAt = input.monotonicNow() + input.policy.rotationRetryIntervalMs;
    input.warnOnce(
      `rotation:${message}`,
      `qwen serve: daemon log rotation failed; ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`
    );
  }, "markRotationFailure");
  const markRetentionFailure = /* @__PURE__ */ __name((error) => {
    input.issues.add("retention_failed");
    input.warnOnce(
      "retention",
      `qwen serve: daemon log retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }, "markRetentionFailure");
  const fileMutationAllowed = /* @__PURE__ */ __name(() => !input.state.poisoned && !input.family.lease.compromised && !input.family.lease.released, "fileMutationAllowed");
  const prepareArchives = /* @__PURE__ */ __name(async () => {
    if (!input.state.archiveAvailable && input.monotonicNow() < input.state.nextRotationRetryAt) {
      return false;
    }
    try {
      await ensureRealDirectory(
        input.fs,
        input.family.archiveDir,
        fileMutationAllowed
      );
      if (!fileMutationAllowed()) return false;
      input.state.archives = await scanArchives(
        input.fs,
        input.family.archiveDir
      );
      input.state.nextArchiveGeneration = (input.state.archives.at(-1)?.generation ?? 0) + 1;
      input.state.archiveAvailable = true;
      input.state.nextRotationRetryAt = 0;
      return true;
    } catch (error) {
      if (!fileMutationAllowed()) return false;
      input.state.archiveAvailable = false;
      markRotationFailure("continuing without file rotation", error);
      return false;
    }
  }, "prepareArchives");
  const pruneForRotation = /* @__PURE__ */ __name(async () => {
    while (input.state.archives.length >= input.policy.maxArchives) {
      if (!fileMutationAllowed()) return false;
      const oldest = input.state.archives[0];
      try {
        await input.fs.unlink(
          nodePath.join(input.family.archiveDir, oldest.name)
        );
        input.state.archives.shift();
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          input.state.archives.shift();
          continue;
        }
        markRetentionFailure(error);
        input.state.nextRotationRetryAt = input.monotonicNow() + input.policy.rotationRetryIntervalMs;
        return false;
      }
    }
    return true;
  }, "pruneForRotation");
  const archivePath = /* @__PURE__ */ __name(async () => {
    const generation = input.state.nextArchiveGeneration;
    if (generation > 999999999999) {
      markRotationFailure("archive generation limit reached");
      return void 0;
    }
    for (let attempt = 0; attempt < ARCHIVE_NAME_ATTEMPTS; attempt += 1) {
      let name;
      try {
        name = `daemon-${String(generation).padStart(12, "0")}-${archiveTimestamp(input.now())}-${crypto.randomBytes(4).toString("hex")}.log`;
      } catch (error) {
        markRotationFailure("archive filename generation failed", error);
        return void 0;
      }
      const candidate = nodePath.join(input.family.archiveDir, name);
      try {
        await input.fs.lstat(candidate);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return { name, generation };
        markRotationFailure("archive target validation failed", error);
        return void 0;
      }
    }
    markRotationFailure("archive filename collision limit reached");
    return void 0;
  }, "archivePath");
  const appendActive = /* @__PURE__ */ __name(async (record, forceRotation = false) => {
    if (!fileMutationAllowed()) return "dropped";
    const bytes = Buffer.byteLength(record, "utf8");
    const needsRotation = input.state.currentBytes > 0 && (forceRotation || input.state.currentBytes + bytes > input.policy.maxBytes);
    if (needsRotation) {
      if (input.monotonicNow() < input.state.nextRotationRetryAt) {
        return "dropped";
      }
      if (!await prepareArchives()) return "dropped";
      if (!fileMutationAllowed()) return "dropped";
      if (!await pruneForRotation()) return "dropped";
      const archive = await archivePath();
      if (!archive) return "dropped";
      if (!fileMutationAllowed()) return "dropped";
      try {
        await input.fs.rename(
          input.family.activePath,
          nodePath.join(input.family.archiveDir, archive.name)
        );
      } catch (error) {
        markRotationFailure("active file rename failed", error);
        return "dropped";
      }
      input.state.archives.push(archive);
      input.state.archives.sort(
        (a, b) => a.generation - b.generation || a.name.localeCompare(b.name)
      );
      input.state.nextArchiveGeneration = archive.generation + 1;
      input.state.currentBytes = 0;
      if (!fileMutationAllowed()) return "dropped";
    }
    if (!fileMutationAllowed()) return "dropped";
    try {
      if (input.state.exclusiveBootCreate) {
        await input.fs.writeFile(input.family.activePath, record, {
          encoding: "utf8",
          mode: FILE_MODE,
          flag: "wx"
        });
        input.state.exclusiveBootCreate = false;
      } else {
        await input.fs.appendFile(input.family.activePath, record, {
          encoding: "utf8",
          mode: FILE_MODE,
          flag: "a"
        });
      }
      input.state.currentBytes += bytes;
      return "written";
    } catch (error) {
      input.state.poisoned = true;
      input.issues.add("write_failed");
      input.warnOnce(
        "write-failed",
        `qwen serve: daemon log write failed; file logging disabled for this run: ${error instanceof Error ? error.message : String(error)}`
      );
      return "unknown";
    }
  }, "appendActive");
  const unreportedDropRecord = /* @__PURE__ */ __name(() => {
    const records = droppedRecords - reportedDroppedRecords;
    const bytes = droppedBytes - reportedDroppedBytes;
    if (records <= 0) return void 0;
    return capUtf8Record(
      buildDaemonFileLogLine(
        {
          level: "WARN",
          message: "daemon file log records dropped",
          now: input.now(),
          ctx: { droppedRecords: records, droppedBytes: bytes }
        },
        input.runId,
        input.pid
      ),
      input.policy.maxRecordBytes
    );
  }, "unreportedDropRecord");
  const enqueueRecord = /* @__PURE__ */ __name((record, callerOriginated, onSettled) => {
    const bytes = Buffer.byteLength(record, "utf8");
    if (pendingBytes + bytes > input.policy.maxPendingBytes) {
      if (callerOriginated) markDropped(bytes, true);
      return false;
    }
    pendingBytes += bytes;
    pending = pending.then(async () => {
      let outcome = "unknown";
      try {
        outcome = await appendActive(record);
        if (callerOriginated && outcome === "dropped") markDropped(bytes);
      } catch (error) {
        input.state.poisoned = true;
        input.issues.add("write_failed");
        input.warnOnce(
          "queue-failed",
          `qwen serve: daemon log queue failed; file logging disabled for this run: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        onSettled?.(outcome);
      }
    }).catch(() => {
    }).finally(() => {
      pendingBytes -= bytes;
    });
    return true;
  }, "enqueueRecord");
  const enqueueDropSummary = /* @__PURE__ */ __name(() => {
    if (dropSummaryPending) return;
    const summary = unreportedDropRecord();
    if (!summary) return;
    const summaryRecords = droppedRecords;
    const summaryBytes = droppedBytes;
    if (enqueueRecord(summary, false, (outcome) => {
      if (outcome === "written") {
        reportedDroppedRecords = summaryRecords;
        reportedDroppedBytes = summaryBytes;
      }
      dropSummaryPending = false;
    })) {
      dropSummaryPending = true;
      overflowEpisode = false;
    }
  }, "enqueueDropSummary");
  const submitFileRecord = /* @__PURE__ */ __name((record) => {
    if (!acceptingFileRecords) return;
    const bytes = Buffer.byteLength(record, "utf8");
    if (!fileMutationAllowed()) {
      markDropped(bytes);
      return;
    }
    enqueueDropSummary();
    enqueueRecord(record, true);
  }, "submitFileRecord");
  const tee = /* @__PURE__ */ __name((level, message, ctx, err) => {
    const timestamp = input.now();
    const traceContext = getActiveTraceContext();
    input.stderr(
      formatDaemonLogLine({
        level,
        message,
        now: timestamp,
        ctx,
        err,
        traceContext
      }).trimEnd()
    );
    submitFileRecord(
      capUtf8Record(
        buildDaemonFileLogLine(
          { level, message, now: timestamp, ctx, err, traceContext },
          input.runId,
          input.pid
        ),
        input.policy.maxRecordBytes
      )
    );
  }, "tee");
  const finalize = /* @__PURE__ */ __name(async () => {
    await pending;
    const summary = unreportedDropRecord();
    if (summary && !input.state.poisoned && !input.family.lease.compromised) {
      if (await appendActive(summary) === "written") {
        reportedDroppedRecords = droppedRecords;
        reportedDroppedBytes = droppedBytes;
      }
    }
    if (input.family.mode === "fallback") {
      await closeFallbackFamily({
        ...input,
        onRetentionError: markRetentionFailure
      });
    } else {
      await input.family.releaseLease().catch((error) => {
        input.warnOnce(
          "release-failed",
          `qwen serve: daemon log lease release failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
  }, "finalize");
  const logger = {
    info: /* @__PURE__ */ __name((message, ctx) => tee("INFO", message, ctx), "info"),
    warn: /* @__PURE__ */ __name((message, ctx) => tee("WARN", message, ctx), "warn"),
    error: /* @__PURE__ */ __name((message, err, ctx) => tee("ERROR", message, ctx, err ?? void 0), "error"),
    raw: /* @__PURE__ */ __name((line, level = "info") => {
      submitFileRecord(
        capUtf8Record(
          buildDaemonFileLogLine(
            {
              level: level.toUpperCase(),
              message: line,
              now: input.now()
            },
            input.runId,
            input.pid
          ),
          input.policy.maxRecordBytes
        )
      );
    }, "raw"),
    getLogPath: /* @__PURE__ */ __name(() => input.family.activePath, "getLogPath"),
    getDaemonId: /* @__PURE__ */ __name(() => input.daemonId, "getDaemonId"),
    getStatus: /* @__PURE__ */ __name(() => statusSnapshot(
      input.runId,
      input.family.mode,
      input.issues,
      droppedRecords,
      droppedBytes
    ), "getStatus"),
    flush: /* @__PURE__ */ __name(() => pending, "flush"),
    close: /* @__PURE__ */ __name(() => {
      if (closePromise) return closePromise;
      acceptingFileRecords = false;
      const finalizer = finalize().catch((error) => {
        try {
          input.warnOnce(
            "close-failed",
            `qwen serve: daemon log close failed: ${error instanceof Error ? error.message : String(error)}`
          );
        } catch {
        }
      });
      let timeout;
      const deadline = new Promise((resolve3) => {
        timeout = setTimeout(() => {
          try {
            input.warnOnce(
              "close-timeout",
              `qwen serve: daemon log close drain exceeded ${input.policy.closeDrainBudgetMs}ms; ownership will release after pending I/O settles or process exit`
            );
          } catch {
          } finally {
            resolve3();
          }
        }, input.policy.closeDrainBudgetMs);
        timeout.unref();
      });
      closePromise = Promise.race([finalizer, deadline]).then(() => {
        if (timeout) clearTimeout(timeout);
      });
      return closePromise;
    }, "close")
  };
  return { logger, writeInitialRecord: appendActive };
}
__name(createConcreteLogger, "createConcreteLogger");
async function initDaemonLogger(opts) {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const stderr = opts.stderr ?? writeStderrLine;
  const baseDir = opts.baseDir ?? resolveDaemonLogBaseDir();
  const runId = opts.runId ?? crypto.randomBytes(16).toString("hex");
  const policy = resolvePolicy(opts.policy);
  const fs2 = opts.fs ?? nodeFs.promises;
  const acquireLock = opts.acquireLock ?? import_proper_lockfile.default.lock;
  const issues = /* @__PURE__ */ new Set();
  const warned = /* @__PURE__ */ new Set();
  const warnOnce = /* @__PURE__ */ __name((key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      stderr(message);
    } catch {
    }
  }, "warnOnce");
  if (isOptedOut()) {
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues
    });
  }
  const daemonDir = nodePath.join(baseDir, "daemon");
  try {
    await ensureRealDirectory(fs2, daemonDir);
  } catch (error) {
    issues.add("init_failed");
    warnOnce(
      "init",
      `qwen serve: daemon log disabled \u2014 init failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues
    });
  }
  let currentState;
  const onCompromised = /* @__PURE__ */ __name((error) => {
    issues.add("lease_compromised");
    if (currentState) currentState.poisoned = true;
    warnOnce(
      "lease-compromised",
      `qwen serve: daemon log lease compromised; file logging disabled for this run: ${error.message}`
    );
  }, "onCompromised");
  const tryFamily = /* @__PURE__ */ __name(async (family) => {
    let state;
    try {
      const currentBytes = await activeFileSize(fs2, family.activePath);
      if (family.mode === "fallback" && currentBytes !== 0) {
        throw new Error(
          "New fallback family unexpectedly contains an active log"
        );
      }
      const completeTail = await lastByteIsNewline(
        fs2,
        family.activePath,
        currentBytes
      );
      let archiveAvailable = true;
      let archives = [];
      const familyMutationAllowed = /* @__PURE__ */ __name(() => !family.lease.compromised && !family.lease.released, "familyMutationAllowed");
      try {
        await ensureRealDirectory(fs2, family.archiveDir, familyMutationAllowed);
        if (!familyMutationAllowed()) {
          throw new Error("Daemon log family lease was compromised");
        }
        archives = await scanArchives(fs2, family.archiveDir);
      } catch (error) {
        archiveAvailable = false;
        if (familyMutationAllowed()) {
          issues.add("rotation_failed");
          warnOnce(
            `archive-init:${family.mode}`,
            `qwen serve: daemon log archive unavailable; active file will remain bounded: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      state = {
        currentBytes,
        archives,
        nextArchiveGeneration: (archives.at(-1)?.generation ?? 0) + 1,
        archiveAvailable,
        exclusiveBootCreate: family.mode === "fallback",
        poisoned: false,
        nextRotationRetryAt: archiveAvailable ? 0 : monotonicNow() + policy.rotationRetryIntervalMs
      };
      currentState = state;
      const concrete = createConcreteLogger({
        fs: fs2,
        acquireLock,
        policy,
        family,
        state,
        runId,
        pid,
        daemonId: computeDaemonId(pid),
        now,
        monotonicNow,
        stderr,
        issues,
        warnOnce
      });
      const bootCtx = {
        workspace: opts.boundWorkspace,
        workspaceHash: computeWorkspaceHash(opts.boundWorkspace)
      };
      const bootTime = now();
      const plainBoot = capUtf8Record(
        buildDaemonFileLogLine(
          {
            level: "INFO",
            message: "daemon started",
            now: bootTime,
            ctx: bootCtx
          },
          runId,
          pid
        ),
        policy.maxRecordBytes
      );
      const incompleteTailBoot = !completeTail ? `
${capUtf8Record(
        buildDaemonFileLogLine(
          {
            level: "INFO",
            message: "daemon started",
            now: bootTime,
            ctx: { ...bootCtx, previousTailIncomplete: true }
          },
          runId,
          pid
        ),
        policy.maxRecordBytes - 1
      )}` : plainBoot;
      const wouldRotate = currentBytes > 0 && currentBytes + Buffer.byteLength(incompleteTailBoot, "utf8") > policy.maxBytes;
      const bootRecord = !completeTail && !wouldRotate ? incompleteTailBoot : plainBoot;
      const bootOutcome = await concrete.writeInitialRecord(
        bootRecord,
        wouldRotate
      );
      if (bootOutcome !== "written" || state.poisoned || family.lease.compromised) {
        return void 0;
      }
      if (state.archiveAvailable && state.archives.length > policy.maxArchives) {
        try {
          while (state.archives.length > policy.maxArchives) {
            if (family.lease.compromised || family.lease.released) break;
            const oldest = state.archives[0];
            if (!oldest) break;
            try {
              await fs2.unlink(nodePath.join(family.archiveDir, oldest.name));
            } catch (error) {
              if (!isErrno(error, "ENOENT")) throw error;
            }
            state.archives.shift();
          }
        } catch (error) {
          issues.add("retention_failed");
          state.nextRotationRetryAt = monotonicNow() + policy.rotationRetryIntervalMs;
          warnOnce(
            "startup-retention",
            `qwen serve: daemon log retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return concrete.logger;
    } catch (error) {
      warnOnce(
        `family-init:${family.mode}`,
        `qwen serve: daemon ${family.mode} log initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }, "tryFamily");
  try {
    const stableLease = await acquireLease({
      fs: fs2,
      acquireLock,
      targetPath: daemonDir,
      lockPath: nodePath.join(daemonDir, ".stable-writer.lock"),
      policy,
      retryBudgetMs: policy.stableAcquireBudgetMs,
      onCompromised
    });
    const stableFamily = {
      mode: "stable",
      activePath: nodePath.join(daemonDir, "daemon.log"),
      archiveDir: nodePath.join(daemonDir, "archive"),
      familyDir: daemonDir,
      lease: stableLease,
      releaseLease: stableLease.release
    };
    const stableLogger = await tryFamily(stableFamily);
    if (stableLogger) {
      if (!stableLease.compromised && !stableLease.released) {
        await updateLatestBestEffort(
          fs2,
          daemonDir,
          stableFamily.activePath,
          () => !stableLease.compromised && !stableLease.released
        );
      }
      if (!stableLease.compromised && !stableLease.released) {
        await cleanupFallbacksBestEffort({
          fs: fs2,
          acquireLock,
          policy,
          daemonDir,
          mutationAllowed: /* @__PURE__ */ __name(() => !stableLease.compromised && !stableLease.released, "mutationAllowed"),
          onRetentionError: /* @__PURE__ */ __name((error) => {
            issues.add("retention_failed");
            warnOnce(
              "fallback-retention",
              `qwen serve: daemon fallback log cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }, "onRetentionError")
        });
      }
      return stableLogger;
    }
    issues.add("init_failed");
    try {
      await stableLease.release();
    } catch (error) {
      warnOnce(
        "stable-release",
        `qwen serve: daemon stable log lease release failed; trying fallback: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } catch (error) {
    if (isErrno(error, "ELOCKED")) {
      warnOnce(
        "stable-contention",
        `qwen serve: daemon stable log is owned by another daemon instance; using a fallback log for runId=${runId}`
      );
    } else {
      issues.add("init_failed");
      warnOnce(
        "stable-lock",
        `qwen serve: daemon stable log unavailable; trying a fallback: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  let fallbackFamily;
  try {
    fallbackFamily = await allocateFallbackFamily({
      fs: fs2,
      acquireLock,
      policy,
      daemonDir,
      runId,
      onCompromised
    });
    const activeFallbackFamily = fallbackFamily;
    const fallbackLogger = await tryFamily(activeFallbackFamily);
    if (!fallbackLogger) {
      issues.add("init_failed");
      await removeFailedFallbackBestEffort({
        fs: fs2,
        acquireLock,
        policy,
        family: activeFallbackFamily
      });
      return createStderrOnlyLogger({
        runId,
        daemonId: computeDaemonId(pid),
        now,
        stderr,
        issues
      });
    }
    const runsDir = nodePath.dirname(activeFallbackFamily.familyDir);
    try {
      if (activeFallbackFamily.lease.compromised) return fallbackLogger;
      const maintenance = await acquireMaintenanceLease({
        fs: fs2,
        acquireLock,
        policy,
        runsDir,
        retryBudgetMs: 0
      });
      try {
        if (!activeFallbackFamily.lease.compromised) {
          await writeRecentFallback(
            fs2,
            runsDir,
            nodePath.basename(activeFallbackFamily.familyDir),
            () => !maintenance.compromised && !maintenance.released && !activeFallbackFamily.lease.compromised
          );
        }
      } finally {
        await maintenance.release();
      }
    } catch (error) {
      warnOnce(
        "fallback-locator",
        `qwen serve: daemon fallback locator update failed; use ${activeFallbackFamily.activePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return fallbackLogger;
  } catch (error) {
    issues.add("init_failed");
    await fallbackFamily?.releaseLease().catch(() => {
    });
    warnOnce(
      "fallback-init",
      `qwen serve: daemon log disabled \u2014 fallback init failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues
    });
  }
}
__name(initDaemonLogger, "initDaemonLogger");

// packages/cli/src/serve/conversations/conversation-workspace.ts
init_esbuild_shims();
import { constants as fsConstants } from "node:fs";
import { open, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
function liveIdentityError(error, exactRoot = false, creatingRoot = false) {
  if (!(error instanceof ConversationDirectoryIdentityError)) throw error;
  if (error.reason === "io_error" && error.cause !== void 0) {
    throw error.cause;
  }
  if (error.scope === "root") {
    switch (error.reason) {
      case "not_directory":
        throw new Error(
          "Live conversation root must be a non-symlink directory"
        );
      case "wrong_owner":
        throw new Error(
          "Live conversation root must be owned by the daemon user"
        );
      case "wrong_mode":
        throw new Error(
          "Live conversation root must be accessible only to its owner"
        );
      case "canonical_path_changed":
        throw new Error("Live conversation root canonical path changed");
      case "identity_changed":
        throw new Error(
          creatingRoot ? "Live conversation root identity changed during validation" : "Live conversation root identity changed"
        );
      case "unexpected_identity":
        if (exactRoot) {
          throw new Error("Workspace must be the exact Live conversation root");
        }
        throw new Error("Live conversation root identity changed");
      default:
        throw new Error("Live conversation root identity changed");
    }
  }
  switch (error.reason) {
    case "invalid_session_id":
      throw new Error("Live conversation session id is invalid");
    case "not_directory":
      throw new Error(
        "Live conversation directory must be a non-symlink directory"
      );
    case "wrong_owner":
      throw new Error(
        "Live conversation directory must be owned by the daemon user"
      );
    case "wrong_mode":
      throw new Error(
        "Live conversation directory must be accessible only to its owner"
      );
    default:
      throw new Error(
        "Live conversation directory must be an owned direct child"
      );
  }
}
__name(liveIdentityError, "liveIdentityError");
function getConversationRootPath(homeDir = homedir()) {
  return resolve(homeDir, "Documents", "Qwen Code", "Conversations");
}
__name(getConversationRootPath, "getConversationRootPath");
async function revalidateConversationRoot(root) {
  try {
    return await revalidateConversationRootIdentity(root);
  } catch (error) {
    liveIdentityError(error);
  }
}
__name(revalidateConversationRoot, "revalidateConversationRoot");
async function assertExactConversationRoot(root, candidate) {
  try {
    return await assertExactConversationRootIdentity(root, candidate);
  } catch (error) {
    liveIdentityError(error, true);
  }
}
__name(assertExactConversationRoot, "assertExactConversationRoot");
var ConversationWorkspace = class {
  static {
    __name(this, "ConversationWorkspace");
  }
  rootPath;
  rootPromise;
  constructor(options = {}) {
    this.rootPath = getConversationRootPath(options.homeDir);
  }
  getRootIdentity() {
    if (!this.rootPromise) {
      const pending = createConversationRootIdentity(this.rootPath);
      this.rootPromise = pending;
      void pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = void 0;
      });
    }
    return this.rootPromise;
  }
  async getRoot() {
    try {
      return await this.getRootIdentity();
    } catch (error) {
      liveIdentityError(error, false, true);
    }
  }
  async revalidateStandaloneRoot() {
    return revalidateConversationRootIdentity(await this.getRootIdentity());
  }
  async revalidate() {
    return revalidateConversationRoot(await this.getRoot());
  }
  async assertExactRoot(candidate) {
    return assertExactConversationRoot(await this.getRoot(), candidate);
  }
  /**
   * The private directory is derived from the canonical session id, not from
   * whatever spelling a caller happens to hold.
   *
   * `getConversationDirectoryName()` is a case-sensitive hash, and callers reach
   * these methods with a mix of request ids, live-entry ids and ids echoed back
   * from tool arguments. Canonicalizing here makes one session resolve to one
   * directory by construction instead of leaving it to every call site.
   */
  directoryKey(sessionId) {
    return normalizeSessionIdForLookup(sessionId);
  }
  async materializeConversationDirectory(sessionId) {
    const root = await this.revalidate();
    try {
      return (await materializeConversationDirectoryIdentity(
        root,
        this.directoryKey(sessionId)
      )).identity.canonicalPath;
    } catch (error) {
      liveIdentityError(error);
    }
  }
  async discardEmptyConversationDirectory(sessionId) {
    const root = await this.revalidate();
    let identity;
    try {
      identity = await inspectConversationDirectoryIdentity(
        root,
        this.directoryKey(sessionId)
      );
    } catch (error) {
      if (error instanceof ConversationDirectoryIdentityError && error.reason === "io_error" && error.cause?.code === "ENOENT") {
        return false;
      }
      liveIdentityError(error);
    }
    if (!identity) return false;
    try {
      await rmdir(identity.canonicalPath);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTEMPTY") {
        return false;
      }
      throw error;
    }
    await revalidateConversationRoot(root);
    return true;
  }
  async prepareStandaloneDirectory(storageSessionId) {
    const root = await this.revalidateStandaloneRoot();
    const prepared = await materializeConversationDirectoryIdentity(
      root,
      storageSessionId
    );
    const identity = await inspectConversationDirectoryIdentity(
      root,
      storageSessionId,
      prepared.identity
    );
    if (!identity) {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    let entries;
    try {
      entries = await readdir(identity.canonicalPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ConversationDirectoryIdentityError(
          "child",
          "identity_changed"
        );
      }
      throw new ConversationDirectoryIdentityError("child", "io_error", error);
    }
    if (entries.length > 0) {
      throw new ConversationDirectoryIdentityError("child", "not_empty");
    }
    return { identity, created: prepared.created };
  }
  async inspectStandaloneDirectory(storageSessionId, expected) {
    const root = await this.revalidateStandaloneRoot();
    try {
      const identity = await inspectConversationDirectoryIdentity(
        root,
        storageSessionId,
        expected
      );
      return identity ? { status: "ready", identity } : { status: "missing" };
    } catch (error) {
      if (error instanceof ConversationDirectoryIdentityError && error.scope === "child") {
        return { status: "compromised", error };
      }
      throw error;
    }
  }
  async ensureStandaloneDirectory(storageSessionId, expected) {
    const inspected = await this.inspectStandaloneDirectory(
      storageSessionId,
      expected
    );
    if (inspected.status !== "missing") return inspected;
    const root = await this.revalidateStandaloneRoot();
    try {
      const materialized = await materializeConversationDirectoryIdentity(
        root,
        storageSessionId
      );
      if (!materialized.created) {
        const raced = await this.inspectStandaloneDirectory(
          storageSessionId,
          expected
        );
        if (raced.status !== "missing") return raced;
        throw new ConversationDirectoryIdentityError(
          "child",
          "identity_changed"
        );
      }
      return {
        status: expected ? "recreated" : "created",
        identity: materialized.identity
      };
    } catch (error) {
      if (error instanceof ConversationDirectoryIdentityError && error.scope === "child") {
        return { status: "compromised", error };
      }
      throw error;
    }
  }
  async inspectStandaloneDeletionPaths(storageSessionId, expected) {
    const root = await this.revalidateStandaloneRoot();
    try {
      const normal = await inspectConversationDirectoryIdentity(
        root,
        storageSessionId
      );
      const staged = await inspectConversationStagedDirectoryIdentity(
        root,
        storageSessionId
      );
      if (normal && staged) {
        throw new ConversationDirectoryIdentityError(
          "child",
          "unexpected_identity"
        );
      }
      const identity = normal ?? staged;
      if (identity && expected && !isSameConversationDirectoryObject(identity, expected)) {
        throw new ConversationDirectoryIdentityError(
          "child",
          "unexpected_identity"
        );
      }
      if (normal) return { status: "normal", identity: normal };
      if (staged) return { status: "staged", identity: staged };
      return { status: "absent" };
    } catch (error) {
      if (error instanceof ConversationDirectoryIdentityError && error.scope === "child") {
        return { status: "compromised", error };
      }
      throw error;
    }
  }
  async createStandaloneDeletionExpectation(storageSessionId, recorded) {
    if (recorded.inodeVerifiable !== (recorded.inode !== 0)) {
      throw new ConversationDirectoryIdentityError(
        "child",
        "unexpected_identity"
      );
    }
    const root = await this.revalidateStandaloneRoot();
    const name = getConversationDirectoryName(storageSessionId);
    return {
      root,
      storageSessionId,
      name,
      canonicalPath: join2(root.canonicalRoot, name),
      device: recorded.device,
      inode: recorded.inode
    };
  }
  async stageStandaloneDirectory(storageSessionId, expected) {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected
    );
    if (inspected.status === "compromised") throw inspected.error;
    if (inspected.status !== "normal") {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    const root = await this.revalidateStandaloneRoot();
    await rename(
      inspected.identity.canonicalPath,
      join2(
        root.canonicalRoot,
        getConversationStagedDirectoryName(storageSessionId)
      )
    );
    await revalidateConversationRootIdentity(root);
    const staged = await inspectConversationStagedDirectoryIdentity(
      root,
      storageSessionId
    );
    if (!staged || !isSameConversationDirectoryObject(staged, inspected.identity)) {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    await this.syncStandaloneRoot(root);
    return staged;
  }
  async restoreStagedStandaloneDirectory(storageSessionId, expected) {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected
    );
    if (inspected.status === "compromised") throw inspected.error;
    if (inspected.status !== "staged") {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    const root = await this.revalidateStandaloneRoot();
    await rename(
      inspected.identity.canonicalPath,
      join2(root.canonicalRoot, getConversationDirectoryName(storageSessionId))
    );
    await revalidateConversationRootIdentity(root);
    const restored = await inspectConversationDirectoryIdentity(
      root,
      storageSessionId
    );
    if (!restored || !isSameConversationDirectoryObject(restored, inspected.identity)) {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    await this.syncStandaloneRoot(root);
    return restored;
  }
  async removeStagedStandaloneDirectory(storageSessionId, expected) {
    const inspected = await this.inspectStandaloneDeletionPaths(
      storageSessionId,
      expected
    );
    if (inspected.status === "compromised") throw inspected.error;
    if (inspected.status !== "staged") {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    const confirmed = await inspectConversationStagedDirectoryIdentity(
      inspected.identity.root,
      storageSessionId
    );
    if (!confirmed || !isSameConversationDirectoryObject(confirmed, inspected.identity)) {
      throw new ConversationDirectoryIdentityError("child", "identity_changed");
    }
    await rm(confirmed.canonicalPath, { recursive: true });
    await this.syncStandaloneRoot(confirmed.root);
  }
  async confirmStandaloneRootDurability(root) {
    await this.syncStandaloneRoot(root);
  }
  async syncStandaloneRoot(root) {
    await revalidateConversationRootIdentity(root);
    let handle;
    try {
      handle = await open(
        root.canonicalRoot,
        fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW ?? 0)
      );
      const stats = await handle.stat();
      const inodeVerifiable = Number.isSafeInteger(stats.ino) && stats.ino > 0;
      if (!stats.isDirectory() || stats.dev !== root.device || inodeVerifiable !== root.inodeVerifiable || root.inodeVerifiable && stats.ino !== root.inode) {
        throw new ConversationDirectoryIdentityError(
          "root",
          "identity_changed"
        );
      }
      try {
        await handle.sync();
      } catch (error) {
        if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(
          error.code ?? ""
        )) {
          throw error;
        }
      }
      const current = await stat(root.canonicalRoot);
      const currentInodeVerifiable = Number.isSafeInteger(current.ino) && current.ino > 0;
      if (!current.isDirectory() || current.dev !== root.device || currentInodeVerifiable !== root.inodeVerifiable || root.inodeVerifiable && current.ino !== root.inode) {
        throw new ConversationDirectoryIdentityError(
          "root",
          "identity_changed"
        );
      }
    } finally {
      await handle?.close().catch(() => void 0);
    }
    await revalidateConversationRootIdentity(root);
  }
};

// packages/cli/src/serve/daemon-metrics-ring.ts
init_esbuild_shims();
var MAX_SAMPLES_PER_WINDOW = 4096;
var DaemonMetricsRing = class {
  static {
    __name(this, "DaemonMetricsRing");
  }
  capacity;
  buckets = [];
  curRequests = 0;
  curErrors = 0;
  curDurations = [];
  curPromptsCompleted = 0;
  curQueueWaits = [];
  curPromptDurations = [];
  curLlmDurations = [];
  curLlmApiErrors = 0;
  curLlmApiRetries = 0;
  curPipeInBytes = 0;
  curPipeOutBytes = 0;
  curTokensIn = 0;
  curTokensOut = 0;
  constructor(options) {
    this.capacity = Math.max(1, Math.floor(options.capacity));
  }
  /** Fold one completed HTTP request into the open window. */
  recordRequest(durationMs, statusCode) {
    this.curRequests += 1;
    if (statusCode >= 400) this.curErrors += 1;
    pushCapped(this.curDurations, durationMs);
  }
  /** Fold one prompt's queue wait (dispatched from the per-session FIFO). */
  recordPromptQueueWait(durationMs) {
    pushCapped(this.curQueueWaits, durationMs);
  }
  /** Fold one finished prompt's end-to-end duration (also counts throughput). */
  recordPromptDuration(durationMs) {
    this.curPromptsCompleted += 1;
    pushCapped(this.curPromptDurations, durationMs);
  }
  /** Fold one model round's LLM API round-trip time (from the token frame). */
  recordLlmDuration(durationMs) {
    pushCapped(this.curLlmDurations, durationMs);
  }
  /**
   * Fold one model round's per-round model-API-error and automatic-retry
   * increments (from the same token frame) into the open window. Both are
   * plain counters — a burst in one window accrues exactly, past the sample
   * cap that only bounds the percentile arrays. Non-finite / negative inputs
   * are ignored so a malformed frame cannot poison the totals.
   */
  recordApiActivity(errors, retries) {
    if (Number.isFinite(errors) && errors > 0) this.curLlmApiErrors += errors;
    if (Number.isFinite(retries) && retries > 0) {
      this.curLlmApiRetries += retries;
    }
  }
  /** Fold one ACP-child pipe message's payload size into the open window. */
  recordPipe(direction, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (direction === "inbound") this.curPipeInBytes += bytes;
    else this.curPipeOutBytes += bytes;
  }
  /** Fold one model turn's token usage into the open window. */
  recordTokens(inputTokens, outputTokens) {
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.curTokensIn += inputTokens;
    }
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      this.curTokensOut += outputTokens;
    }
  }
  /**
   * Seal the open window into a bucket stamped at `now` (folding in the
   * gauges), append it, evict the oldest past capacity, then reset the
   * accumulators for the next window.
   */
  sample(now, gauges) {
    this.buckets.push({
      t: now,
      activeSessions: finiteGauge(gauges.activeSessions),
      activePrompts: finiteGauge(gauges.activePrompts),
      queuedPrompts: finiteGauge(gauges.queuedPrompts),
      requests: this.curRequests,
      errors: this.curErrors,
      latencyP50Ms: percentile(this.curDurations, 0.5),
      latencyP95Ms: percentile(this.curDurations, 0.95),
      promptsCompleted: this.curPromptsCompleted,
      promptQueueWaitP95Ms: percentile(this.curQueueWaits, 0.95),
      promptDurationP95Ms: percentile(this.curPromptDurations, 0.95),
      llmApiP50Ms: percentile(this.curLlmDurations, 0.5),
      llmApiP95Ms: percentile(this.curLlmDurations, 0.95),
      llmApiErrors: this.curLlmApiErrors,
      llmApiRetries: this.curLlmApiRetries,
      cpuPercent: finiteGauge(gauges.cpuPercent),
      rssBytes: finiteGauge(gauges.rssBytes),
      heapUsedBytes: finiteGauge(gauges.heapUsedBytes),
      eventLoopLagP99Ms: finiteGauge(gauges.eventLoopLagP99Ms),
      pipeInBytes: this.curPipeInBytes,
      pipeOutBytes: this.curPipeOutBytes,
      sseConnections: finiteGauge(gauges.sseConnections),
      wsConnections: finiteGauge(gauges.wsConnections),
      acpConnections: finiteGauge(gauges.acpConnections),
      rateLimitRejected: finiteGauge(gauges.rateLimitRejected),
      tokensIn: this.curTokensIn,
      tokensOut: this.curTokensOut,
      childCpuPercent: finiteGauge(gauges.childCpuPercent),
      childRssBytes: finiteGauge(gauges.childRssBytes)
    });
    if (this.buckets.length > this.capacity) {
      this.buckets.splice(0, this.buckets.length - this.capacity);
    }
    this.curRequests = 0;
    this.curErrors = 0;
    this.curDurations.length = 0;
    this.curPromptsCompleted = 0;
    this.curQueueWaits.length = 0;
    this.curPromptDurations.length = 0;
    this.curLlmDurations.length = 0;
    this.curLlmApiErrors = 0;
    this.curLlmApiRetries = 0;
    this.curPipeInBytes = 0;
    this.curPipeOutBytes = 0;
    this.curTokensIn = 0;
    this.curTokensOut = 0;
  }
  /** Oldest→newest copy of the retained buckets (safe to serialize). */
  snapshot() {
    return this.buckets.slice();
  }
};
function finiteGauge(value) {
  return Number.isFinite(value) ? value : 0;
}
__name(finiteGauge, "finiteGauge");
function pushCapped(target, value) {
  if (Number.isFinite(value) && value >= 0 && target.length < MAX_SAMPLES_PER_WINDOW) {
    target.push(value);
  }
}
__name(pushCapped, "pushCapped");
function percentile(samples, q) {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}
__name(percentile, "percentile");

// packages/cli/src/serve/large-pipe-frame-observer.ts
init_esbuild_shims();
var LARGE_PIPE_FRAME_THRESHOLD_BYTES = 256 * 1024;
var LARGE_PIPE_FRAME_LOG_LIMIT = 50;
var LARGE_PIPE_FRAME_LOG_WINDOW_MS = 6e4;
var LARGE_PIPE_FRAME_EVENT_NAME = "qwen-code.daemon.pipe.large_frame";
var MAX_ATTR_STRING_LENGTH = 128;
var MAX_CONTENT_DEPTH = 32;
var MAX_JSON_APPROX_DEPTH = 32;
var MAX_RAW_OUTPUT_APPROX_BYTES = LARGE_PIPE_FRAME_THRESHOLD_BYTES;
var MAX_SUMMARIZED_UPDATES = 500;
var SUMMARIZED_UPDATE_PREFIX_COUNT = Math.ceil(MAX_SUMMARIZED_UPDATES / 2);
var SUMMARIZED_UPDATE_SUFFIX_COUNT = MAX_SUMMARIZED_UPDATES - SUMMARIZED_UPDATE_PREFIX_COUNT;
function createLargePipeFrameObserver(options) {
  const thresholdBytes = options.thresholdBytes ?? LARGE_PIPE_FRAME_THRESHOLD_BYTES;
  const windowMs = options.windowMs ?? LARGE_PIPE_FRAME_LOG_WINDOW_MS;
  const logLimit = options.logLimit ?? LARGE_PIPE_FRAME_LOG_LIMIT;
  const now = options.now ?? Date.now;
  let windowStartedAt = now();
  let emittedInWindow = 0;
  let suppressedCount = 0;
  let suppressedWindowStartMs;
  return (observation) => {
    try {
      if (observation.bytes < thresholdBytes) return;
      const currentTime = now();
      if (currentTime - windowStartedAt >= windowMs) {
        windowStartedAt = currentTime;
        emittedInWindow = 0;
      }
      if (emittedInWindow >= logLimit) {
        suppressedCount += 1;
        suppressedWindowStartMs ??= windowStartedAt;
        return;
      }
      const context = classifyLargePipeFrame(observation, thresholdBytes);
      if (!context) return;
      if (suppressedCount > 0) {
        context["suppressedCount"] = suppressedCount;
        if (suppressedWindowStartMs !== void 0) {
          context["suppressedWindowStartMs"] = suppressedWindowStartMs;
        }
        suppressedCount = 0;
        suppressedWindowStartMs = void 0;
      }
      emittedInWindow += 1;
      try {
        options.daemonLog.warn("large ACP pipe frame observed", context);
      } catch {
      }
      try {
        options.emitTelemetryLog?.("Large ACP pipe frame observed.", context, {
          eventName: LARGE_PIPE_FRAME_EVENT_NAME
        });
      } catch {
      }
    } catch {
    }
  };
}
__name(createLargePipeFrameObserver, "createLargePipeFrameObserver");
function classifyLargePipeFrame(observation, thresholdBytes = LARGE_PIPE_FRAME_THRESHOLD_BYTES) {
  if (observation.bytes < thresholdBytes) return void 0;
  const message = asRecord(observation.message);
  const messageKind = message ? getMessageKind(message) : "unknown";
  const method = message ? stringValue(message["method"]) : void 0;
  const classification = classifySource(message, messageKind, method);
  const context = {
    direction: observation.direction,
    bytes: observation.bytes,
    thresholdBytes,
    messageKind,
    sourceClass: classification.sourceClass
  };
  addString(context, "method", method);
  if (classification.sourceClass === "session_update_notification") {
    addUpdateSummary(context, summarizeUpdate(classification.update));
  } else if (classification.sourceClass === "load_session_bulk_replay_response") {
    addUpdatesSummary(context, classification.replay?.["updates"]);
  } else if (classification.sourceClass === "load_updates_response") {
    addUpdatesSummary(context, classification.result?.["updates"]);
  }
  return context;
}
__name(classifyLargePipeFrame, "classifyLargePipeFrame");
function classifySource(message, messageKind, method) {
  if (!message) return { sourceClass: "unknown" };
  const params = asRecord(message["params"]);
  const update = asRecord(params?.["update"]);
  if (messageKind === "notification" && method === "session/update" && update) {
    return { sourceClass: "session_update_notification", update };
  }
  if (messageKind === "response") {
    const replay = getBulkReplay(message);
    if (replay) {
      return { sourceClass: "load_session_bulk_replay_response", replay };
    }
    const result = asRecord(message["result"]);
    if (isLoadUpdatesResult(result)) {
      return { sourceClass: "load_updates_response", result };
    }
    return { sourceClass: "jsonrpc_response" };
  }
  if (method) return { sourceClass: "jsonrpc_request" };
  return { sourceClass: "unknown" };
}
__name(classifySource, "classifySource");
function getMessageKind(message) {
  const method = stringValue(message["method"]);
  const hasId = Object.hasOwn(message, "id");
  if (method) return hasId ? "request" : "notification";
  if (hasId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    return "response";
  }
  return "unknown";
}
__name(getMessageKind, "getMessageKind");
function getBulkReplay(message) {
  const result = asRecord(message?.["result"]);
  const meta = asRecord(result?.["_meta"]);
  return asRecord(meta?.[LOAD_REPLAY_META_KEY]);
}
__name(getBulkReplay, "getBulkReplay");
function isLoadUpdatesResult(result) {
  if (!Array.isArray(result?.["updates"])) return false;
  return typeof result["startTime"] === "string" || typeof result["lastUpdated"] === "string" || typeof result["replayError"] === "string" || typeof result["partial"] === "boolean";
}
__name(isLoadUpdatesResult, "isLoadUpdatesResult");
function addUpdatesSummary(context, updates) {
  if (!Array.isArray(updates)) return;
  context["updateCount"] = updates.length;
  const sampledIndexes = sampleUpdateIndexes(updates.length);
  if (sampledIndexes.length < updates.length) {
    context["summarizedUpdateCount"] = sampledIndexes.length;
    context["summarizedUpdateStrategy"] = "prefix_and_suffix";
  }
  const summary = {};
  for (const index of sampledIndexes) {
    mergeUpdateSummary(summary, summarizeUpdate(asRecord(updates[index])));
  }
  addUpdateSummary(context, summary);
}
__name(addUpdatesSummary, "addUpdatesSummary");
function sampleUpdateIndexes(updateCount) {
  if (updateCount <= MAX_SUMMARIZED_UPDATES) {
    return Array.from({ length: updateCount }, (_, index) => index);
  }
  const indexes = [];
  for (let i = 0; i < SUMMARIZED_UPDATE_PREFIX_COUNT; i += 1) {
    indexes.push(i);
  }
  for (let i = updateCount - SUMMARIZED_UPDATE_SUFFIX_COUNT; i < updateCount; i += 1) {
    indexes.push(i);
  }
  return indexes;
}
__name(sampleUpdateIndexes, "sampleUpdateIndexes");
function summarizeUpdate(update) {
  if (!update) return {};
  const meta = asRecord(update["_meta"]);
  const summary = {};
  summary.sessionUpdate = stringValue(update["sessionUpdate"]);
  summary.toolName = stringValue(meta?.["toolName"]);
  summary.toolProvenance = stringValue(meta?.["provenance"]);
  const contentBytes = contentTextBytes(update["content"]);
  if (contentBytes > 0) {
    summary.maxContentTextBytes = contentBytes;
  }
  summary.maxObservedUpdateBytes = contentBytes;
  if (Object.hasOwn(update, "rawOutput")) {
    const rawOutput = update["rawOutput"];
    summary.rawOutputKind = rawOutputKind(rawOutput);
    if (typeof rawOutput === "string") {
      const rawOutputTextBytes = Buffer.byteLength(rawOutput, "utf8");
      summary.maxRawOutputTextBytes = rawOutputTextBytes;
      summary.maxRawOutputObservedBytes = rawOutputTextBytes;
      summary.maxObservedUpdateBytes = Math.max(
        summary.maxObservedUpdateBytes,
        rawOutputTextBytes
      );
    } else {
      const rawOutputApprox = approximateJsonByteLength(rawOutput);
      if (rawOutputApprox !== void 0) {
        summary.maxRawOutputApproxBytes = rawOutputApprox.bytes;
        if (rawOutputApprox.capped) {
          summary.maxRawOutputApproxBytesCapped = true;
        }
        summary.maxRawOutputObservedBytes = rawOutputApprox.bytes;
        summary.maxObservedUpdateBytes = Math.max(
          summary.maxObservedUpdateBytes,
          rawOutputApprox.bytes
        );
      }
    }
  }
  return summary;
}
__name(summarizeUpdate, "summarizeUpdate");
function mergeUpdateSummary(target, next) {
  if (next.sessionUpdate && target.sessionUpdate && next.sessionUpdate !== target.sessionUpdate) {
    target.mixedSessionUpdate = true;
  }
  if (next.mixedSessionUpdate) {
    target.mixedSessionUpdate = true;
  }
  if (next.maxObservedUpdateBytes !== void 0 && (target.maxObservedUpdateBytes === void 0 || next.maxObservedUpdateBytes > target.maxObservedUpdateBytes)) {
    target.maxObservedUpdateBytes = next.maxObservedUpdateBytes;
    target.sessionUpdate = next.sessionUpdate ?? target.sessionUpdate;
    target.toolName = next.toolName ?? target.toolName;
    target.toolProvenance = next.toolProvenance ?? target.toolProvenance;
  }
  if (next.maxContentTextBytes !== void 0 && (target.maxContentTextBytes === void 0 || next.maxContentTextBytes > target.maxContentTextBytes)) {
    target.maxContentTextBytes = next.maxContentTextBytes;
  }
  if (next.maxRawOutputTextBytes !== void 0 && (target.maxRawOutputTextBytes === void 0 || next.maxRawOutputTextBytes > target.maxRawOutputTextBytes)) {
    target.maxRawOutputTextBytes = next.maxRawOutputTextBytes;
  }
  if (next.maxRawOutputApproxBytes !== void 0 && (target.maxRawOutputApproxBytes === void 0 || next.maxRawOutputApproxBytes > target.maxRawOutputApproxBytes)) {
    target.maxRawOutputApproxBytes = next.maxRawOutputApproxBytes;
  }
  if (next.maxRawOutputApproxBytesCapped) {
    target.maxRawOutputApproxBytesCapped = true;
  }
  if (next.maxRawOutputObservedBytes !== void 0 && (target.maxRawOutputObservedBytes === void 0 || next.maxRawOutputObservedBytes > target.maxRawOutputObservedBytes)) {
    target.maxRawOutputObservedBytes = next.maxRawOutputObservedBytes;
    target.rawOutputKind = next.rawOutputKind;
  }
}
__name(mergeUpdateSummary, "mergeUpdateSummary");
function addUpdateSummary(context, summary) {
  addString(context, "sessionUpdate", summary.sessionUpdate);
  addString(context, "toolName", summary.toolName);
  addString(context, "toolProvenance", summary.toolProvenance);
  if (summary.mixedSessionUpdate) context["mixedSessionUpdate"] = true;
  addNumber(context, "maxContentTextBytes", summary.maxContentTextBytes);
  addNumber(context, "maxRawOutputTextBytes", summary.maxRawOutputTextBytes);
  addNumber(
    context,
    "maxRawOutputApproxBytes",
    summary.maxRawOutputApproxBytes
  );
  if (summary.maxRawOutputApproxBytesCapped) {
    context["maxRawOutputApproxBytesCapped"] = true;
  }
  addString(context, "rawOutputKind", summary.rawOutputKind);
}
__name(addUpdateSummary, "addUpdateSummary");
function contentTextBytes(value, depth = 0) {
  if (depth > MAX_CONTENT_DEPTH) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => sum + contentTextBytes(item, depth + 1),
      0
    );
  }
  const record = asRecord(value);
  if (!record) return 0;
  let total = 0;
  const text = stringValue(record["text"]);
  if (text) total += Buffer.byteLength(text, "utf8");
  if (Object.hasOwn(record, "content")) {
    total += contentTextBytes(record["content"], depth + 1);
  }
  return total;
}
__name(contentTextBytes, "contentTextBytes");
function approximateJsonByteLength(value) {
  const state = {
    budget: MAX_RAW_OUTPUT_APPROX_BYTES,
    bytes: 0,
    capped: false,
    seen: /* @__PURE__ */ new WeakSet()
  };
  if (!addJsonValueBytes(value, state, 0)) return void 0;
  return { bytes: state.bytes, capped: state.capped };
}
__name(approximateJsonByteLength, "approximateJsonByteLength");
function addJsonValueBytes(value, state, depth) {
  if (state.capped) return true;
  switch (typeof value) {
    case "string":
      addJsonStringBytes(value, state);
      return true;
    case "number":
      addJsonBytes(state, Number.isFinite(value) ? String(value).length : 4);
      return true;
    case "boolean":
      addJsonBytes(state, value ? 4 : 5);
      return true;
    case "object":
      if (value === null) {
        addJsonBytes(state, 4);
        return true;
      }
      if (depth >= MAX_JSON_APPROX_DEPTH) {
        capJsonBytes(state);
        return true;
      }
      if (Array.isArray(value)) {
        addJsonArrayBytes(value, state, depth);
      } else {
        addJsonObjectBytes(value, state, depth);
      }
      return true;
    default:
      return false;
  }
}
__name(addJsonValueBytes, "addJsonValueBytes");
function addJsonArrayBytes(value, state, depth) {
  if (state.seen.has(value)) {
    capJsonBytes(state);
    return;
  }
  state.seen.add(value);
  addJsonBytes(state, 1);
  for (let i = 0; i < value.length && !state.capped; i += 1) {
    if (i > 0) addJsonBytes(state, 1);
    if (!addJsonValueBytes(value[i], state, depth + 1)) {
      addJsonBytes(state, 4);
    }
  }
  addJsonBytes(state, 1);
  state.seen.delete(value);
}
__name(addJsonArrayBytes, "addJsonArrayBytes");
function addJsonObjectBytes(value, state, depth) {
  if (state.seen.has(value)) {
    capJsonBytes(state);
    return;
  }
  state.seen.add(value);
  addJsonBytes(state, 1);
  const record = value;
  let propertyCount = 0;
  for (const key in record) {
    if (state.capped) break;
    if (!Object.hasOwn(record, key)) continue;
    const item = record[key];
    if (isOmittedJsonObjectValue(item)) continue;
    if (propertyCount > 0) addJsonBytes(state, 1);
    addJsonStringBytes(key, state);
    addJsonBytes(state, 1);
    if (!addJsonValueBytes(item, state, depth + 1)) {
      addJsonBytes(state, 4);
    }
    propertyCount += 1;
  }
  addJsonBytes(state, 1);
  state.seen.delete(value);
}
__name(addJsonObjectBytes, "addJsonObjectBytes");
function addJsonStringBytes(value, state) {
  addJsonBytes(state, 1);
  if (state.capped) return;
  const remainingForContent = Math.max(0, state.budget - state.bytes - 1);
  const sampleLength = Math.min(value.length, remainingForContent);
  const sample = sampleLength < value.length ? value.slice(0, sampleLength) : value;
  addJsonBytes(state, Buffer.byteLength(sample, "utf8"));
  if (sampleLength < value.length) {
    capJsonBytes(state);
    return;
  }
  addJsonBytes(state, 1);
}
__name(addJsonStringBytes, "addJsonStringBytes");
function addJsonBytes(state, bytes) {
  if (state.capped || bytes <= 0) return;
  const nextBytes = state.bytes + bytes;
  if (nextBytes >= state.budget) {
    capJsonBytes(state);
    return;
  }
  state.bytes = nextBytes;
}
__name(addJsonBytes, "addJsonBytes");
function capJsonBytes(state) {
  state.bytes = state.budget;
  state.capped = true;
}
__name(capJsonBytes, "capJsonBytes");
function isOmittedJsonObjectValue(value) {
  return typeof value === "undefined" || typeof value === "function" || typeof value === "symbol";
}
__name(isOmittedJsonObjectValue, "isOmittedJsonObjectValue");
function rawOutputKind(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
__name(rawOutputKind, "rawOutputKind");
function addString(context, key, value) {
  if (value === void 0) return;
  context[key] = value.length > MAX_ATTR_STRING_LENGTH ? value.slice(0, MAX_ATTR_STRING_LENGTH) : value;
}
__name(addString, "addString");
function addNumber(context, key, value) {
  if (value !== void 0) context[key] = value;
}
__name(addNumber, "addNumber");
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
__name(stringValue, "stringValue");
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
__name(asRecord, "asRecord");

// packages/cli/src/serve/channel-delivery-authorization.ts
init_esbuild_shims();
function authorizationKey(workspaceCwd, sessionId, id) {
  return JSON.stringify([workspaceCwd, sessionId, id]);
}
__name(authorizationKey, "authorizationKey");
function targetsEqual(left, right) {
  return left.channelName === right.channelName && left.type === right.type && left.id === right.id;
}
__name(targetsEqual, "targetsEqual");
var ChannelDeliveryAuthorizationStore = class {
  static {
    __name(this, "ChannelDeliveryAuthorizationStore");
  }
  #prompts = /* @__PURE__ */ new Map();
  #scheduledTasks = /* @__PURE__ */ new Map();
  authorizePrompt(workspaceCwd, authorization) {
    this.#prompts.set(
      authorizationKey(
        workspaceCwd,
        authorization.sessionId,
        authorization.deliveryId
      ),
      authorization.target
    );
  }
  revokePrompt(workspaceCwd, sessionId, deliveryId) {
    this.#prompts.delete(authorizationKey(workspaceCwd, sessionId, deliveryId));
  }
  registerScheduledTask(workspaceCwd, authorization) {
    const key = authorizationKey(
      workspaceCwd,
      authorization.sessionId,
      authorization.taskId
    );
    const current = this.#scheduledTasks.get(key);
    this.#scheduledTasks.set(key, {
      sessionId: authorization.sessionId,
      taskId: authorization.taskId,
      target: authorization.target,
      recurring: authorization.recurring,
      lastConsumedAt: current?.lastConsumedAt ?? authorization.lastFiredAt ?? 0
    });
  }
  revokeScheduledTask(workspaceCwd, sessionId, taskId) {
    this.#scheduledTasks.delete(
      authorizationKey(workspaceCwd, sessionId, taskId)
    );
  }
  consume(workspaceCwd, request) {
    if (request.source === "prompt") {
      if (request.promptId !== request.deliveryId) return false;
      const key2 = authorizationKey(
        workspaceCwd,
        request.sessionId,
        request.deliveryId
      );
      const target = this.#prompts.get(key2);
      if (!target || !targetsEqual(target, request.target)) return false;
      this.#prompts.delete(key2);
      return true;
    }
    if (typeof request.taskId !== "string" || typeof request.firedAt !== "number" || request.deliveryId !== `${request.taskId}:${request.firedAt}`) {
      return false;
    }
    const key = authorizationKey(
      workspaceCwd,
      request.sessionId,
      request.taskId
    );
    const authorization = this.#scheduledTasks.get(key);
    if (!authorization || request.firedAt <= authorization.lastConsumedAt || !targetsEqual(authorization.target, request.target)) {
      return false;
    }
    if (authorization.recurring) {
      authorization.lastConsumedAt = request.firedAt;
    } else {
      this.#scheduledTasks.delete(key);
    }
    return true;
  }
};

// packages/cli/src/serve/channel-workspace-grouping.ts
init_esbuild_shims();
function resolveChannelOwnerCwd(rawCwd, workspaceCwd) {
  return canonicalizeWorkspace(resolveChannelCwd(rawCwd, workspaceCwd));
}
__name(resolveChannelOwnerCwd, "resolveChannelOwnerCwd");
function rawChannelCwd(entry) {
  if (!entry || typeof entry !== "object") return void 0;
  const cwd = entry.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
}
__name(rawChannelCwd, "rawChannelCwd");
function resolveChannelWorkspaceGroups(input) {
  const { selection, loadChannelsConfig } = input;
  const workspaces = input.workspaces.filter(
    (workspace) => workspace.provenance !== "live-conversation"
  );
  const primary = workspaces.find((workspace) => workspace.primary);
  if (!primary) {
    return {
      ok: false,
      error: {
        code: "no_primary_workspace",
        message: "No primary workspace is registered."
      }
    };
  }
  if (selection.mode === "all") {
    if (!primary.trusted) {
      return {
        ok: false,
        error: {
          code: "untrusted_workspace",
          message: `Primary workspace "${primary.workspaceCwd}" is not trusted; cannot host channels.`
        }
      };
    }
    return {
      ok: true,
      groups: [
        { workspaceCwd: primary.workspaceCwd, selection: { mode: "all" } }
      ]
    };
  }
  const channelsConfigByWorkspace = /* @__PURE__ */ new Map();
  for (const workspace of workspaces) {
    channelsConfigByWorkspace.set(
      workspace.workspaceCwd,
      loadChannelsConfig(workspace.workspaceCwd)
    );
  }
  const namesByWorkspace = /* @__PURE__ */ new Map();
  for (const name of selection.names) {
    const owners = [];
    for (const workspace of workspaces) {
      const entry = (channelsConfigByWorkspace.get(workspace.workspaceCwd) ?? {})[name];
      if (!entry || typeof entry !== "object") continue;
      let ownerCwd;
      try {
        ownerCwd = resolveChannelOwnerCwd(
          rawChannelCwd(entry),
          workspace.workspaceCwd
        );
      } catch {
        continue;
      }
      if (ownerCwd === workspace.workspaceCwd) {
        owners.push(workspace);
      }
    }
    if (owners.length === 0) {
      return {
        ok: false,
        error: {
          code: "channel_workspace_mismatch",
          channel: name,
          message: `Channel "${name}" is not configured in any registered workspace, or its "cwd" points outside them.`
        }
      };
    }
    if (owners.length > 1) {
      return {
        ok: false,
        error: {
          code: "ambiguous_channel_workspace",
          channel: name,
          message: `Channel "${name}" is configured in multiple registered workspaces (${owners.map((owner2) => owner2.workspaceCwd).join(
            ", "
          )}). Define it in one workspace's settings or set an explicit "cwd".`
        }
      };
    }
    const owner = owners[0];
    if (!owner.trusted) {
      return {
        ok: false,
        error: {
          code: "untrusted_workspace",
          channel: name,
          message: `Channel "${name}" targets untrusted workspace "${owner.workspaceCwd}".`
        }
      };
    }
    const names = namesByWorkspace.get(owner.workspaceCwd) ?? [];
    names.push(name);
    namesByWorkspace.set(owner.workspaceCwd, names);
  }
  return {
    ok: true,
    groups: [...namesByWorkspace.entries()].map(([workspaceCwd, names]) => ({
      workspaceCwd,
      selection: { mode: "names", names }
    }))
  };
}
__name(resolveChannelWorkspaceGroups, "resolveChannelWorkspaceGroups");

// packages/cli/src/serve/run-qwen-serve.ts
var QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV = "QWEN_SERVE_CLIENT_MCP_OVER_WS";
var QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV = "QWEN_SERVE_CDP_TUNNEL_OVER_WS";
var QWEN_SERVE_PROMPT_DEADLINE_MS_ENV = "QWEN_SERVE_PROMPT_DEADLINE_MS";
var QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV = "QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS";
var SHUTDOWN_FORCE_CLOSE_MS = 5e3;
var DAEMON_LOG_FORCED_FLUSH_BUDGET_MS = 250;
var DEFAULT_LIVE_DISCOVERY_RETRY_MS = 5e3;
var ENSURE_KEEP_ALIVE_MS = 10 * 6e4;
function deepestErrorMessage(err) {
  if (!(err instanceof Error)) return String(err);
  let deepest = err;
  while (deepest.cause instanceof Error) {
    deepest = deepest.cause;
  }
  return deepest.message;
}
__name(deepestErrorMessage, "deepestErrorMessage");
function channelDeliveryPublicError(code) {
  switch (code) {
    case "channel_worker_unavailable":
      return "Channel worker is unavailable.";
    case "channel_delivery_timeout":
      return "Channel delivery timed out.";
    case "channel_delivery_invalid":
      return "Channel delivery is invalid.";
    case "channel_delivery_rejected":
      return "Channel delivery was rejected.";
    case "channel_delivery_queue_full":
      return "Channel delivery queue is full.";
    case "channel_delivery_failed":
      return "Channel delivery failed.";
    default:
      return "Channel delivery failed.";
  }
}
__name(channelDeliveryPublicError, "channelDeliveryPublicError");
function createBoundChannelDeliveryHandler(boundWorkspace, getManager, authorizations, daemonLog, diagnosticRedaction = {
  workerEnv: {}
}) {
  return async (info) => {
    const failed = /* @__PURE__ */ __name((code, error, diagnostic) => {
      writeDaemonLifecycleBestEffort(() => {
        if (!daemonLog) return;
        let diagnosticText;
        if (diagnostic !== void 0) {
          const message = diagnostic instanceof Error ? diagnostic.message : String(diagnostic);
          const sanitized = sanitizeWorkerDiagnostic(
            message,
            512,
            diagnosticRedaction
          );
          const targetId = normalizeWorkerDiagnostic(info.target.id);
          diagnosticText = sanitizeLogText(
            targetId.length > 0 ? sanitized.replaceAll(targetId, "<redacted>") : sanitized,
            512
          );
        }
        daemonLog.warn("channel delivery failed", {
          sessionId: info.sessionId,
          deliveryId: info.deliveryId,
          source: info.source,
          channelName: info.target.channelName,
          code,
          ...diagnosticText ? { diagnostic: diagnosticText } : {}
        });
      });
      return { status: "failed", code, error };
    }, "failed");
    if (!authorizations.consume(boundWorkspace, info)) {
      return failed(
        "channel_delivery_invalid",
        "Channel delivery is not authorized."
      );
    }
    if (info.text.trim().length === 0) {
      return { status: "skipped" };
    }
    const manager = getManager();
    if (!manager) {
      return failed(
        "channel_worker_unavailable",
        "Channel worker is not running."
      );
    }
    try {
      await manager.deliverChannelMessage(boundWorkspace, {
        deliveryId: info.deliveryId,
        channelName: info.target.channelName,
        target: { type: info.target.type, id: info.target.id },
        text: info.text
      });
      return { status: "delivered" };
    } catch (err) {
      if (isChannelDeliveryError(err)) {
        return failed(err.code, channelDeliveryPublicError(err.code), err);
      }
      return failed("channel_delivery_failed", "Channel delivery failed.", err);
    }
  };
}
__name(createBoundChannelDeliveryHandler, "createBoundChannelDeliveryHandler");
async function flushDaemonLogBounded(daemonLog, budgetMs) {
  let timer;
  try {
    await Promise.race([
      daemonLog.flush().catch(() => {
      }),
      new Promise((resolve3) => {
        timer = setTimeout(resolve3, budgetMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
__name(flushDaemonLogBounded, "flushDaemonLogBounded");
function writeDaemonLifecycleBestEffort(write) {
  try {
    write();
  } catch {
  }
}
__name(writeDaemonLifecycleBestEffort, "writeDaemonLifecycleBestEffort");
function daemonPipeDirection(direction) {
  switch (direction) {
    case "sent":
      return "outbound";
    case "received":
      return "inbound";
    default: {
      const exhaustive = direction;
      return exhaustive;
    }
  }
}
__name(daemonPipeDirection, "daemonPipeDirection");
var DAEMON_METRICS_SAMPLE_MS = 5e3;
var DAEMON_METRICS_CAPACITY = 180;
function safeCpuUsage() {
  try {
    return process.cpuUsage();
  } catch {
    return null;
  }
}
__name(safeCpuUsage, "safeCpuUsage");
var DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS = 12e4;
var FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS = 50;
var FAST_PATH_RUNTIME_START_FALLBACK_MS = 1e3;
var RUNTIME_STARTUP_TIMEOUT_ENV = "QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS";
var MAX_EVENT_RING_SIZE = 1e6;
var DEFAULT_MAX_SESSIONS = 32;
var DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
var DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 6e4;
var DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS = 0;
var WORKSPACE_SETTING_SCOPE = "Workspace";
function isPositiveIntegerMs(value) {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
__name(isPositiveIntegerMs, "isPositiveIntegerMs");
function isNonNegativeIntegerOrInfinity(value) {
  return value === Number.POSITIVE_INFINITY || Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
__name(isNonNegativeIntegerOrInfinity, "isNonNegativeIntegerOrInfinity");
function deriveDefaultMaxTotalSessions(maxSessionsPerWorkspace, workspaceCount, maxRegisteredWorkspaces) {
  if (maxRegisteredWorkspaces > 25) return 800;
  if (workspaceCount <= 1) return void 0;
  const perWorkspace = maxSessionsPerWorkspace ?? DEFAULT_MAX_SESSIONS;
  if (perWorkspace === 0 || perWorkspace === Number.POSITIVE_INFINITY) {
    return void 0;
  }
  return perWorkspace * workspaceCount;
}
__name(deriveDefaultMaxTotalSessions, "deriveDefaultMaxTotalSessions");
function isNonNegativeIntegerMs(value) {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
__name(isNonNegativeIntegerMs, "isNonNegativeIntegerMs");
var MAX_TIMEOUT_MS = 2147483647;
var MAX_PORT_ATTEMPTS = 10;
function assertTimerDelayInRange(name, value) {
  if (value > MAX_TIMEOUT_MS) {
    throw new TypeError(
      `Invalid ${name}: ${value}. Exceeds maximum JS timer delay of ${MAX_TIMEOUT_MS} ms (~24.8 days); Node would silently compress longer delays to 1ms.`
    );
  }
}
__name(assertTimerDelayInRange, "assertTimerDelayInRange");
function parseDeadlineEnv(envName, raw) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!isPositiveIntegerMs(parsed)) {
    throw new Error(
      `Invalid ${envName}="${raw}": must be a positive integer (milliseconds).`
    );
  }
  return parsed;
}
__name(parseDeadlineEnv, "parseDeadlineEnv");
function envFlagDisabled(raw) {
  if (raw === void 0) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "0" || normalized === "false";
}
__name(envFlagDisabled, "envFlagDisabled");
function hasChromeExtensionOrigin(origins) {
  return origins?.some(
    (origin) => origin.trim().toLowerCase().startsWith("chrome-extension://")
  ) === true;
}
__name(hasChromeExtensionOrigin, "hasChromeExtensionOrigin");
function createDaemonTelemetryRuntimeConfig(telemetry, cliVersion, daemonSessionId, defaults) {
  return {
    getTelemetryEnabled: /* @__PURE__ */ __name(() => telemetry.enabled ?? false, "getTelemetryEnabled"),
    getTelemetryOtlpEndpoint: /* @__PURE__ */ __name(() => telemetry.otlpEndpoint ?? defaults.otlpEndpoint, "getTelemetryOtlpEndpoint"),
    getTelemetryOtlpProtocol: /* @__PURE__ */ __name(() => telemetry.otlpProtocol ?? "grpc", "getTelemetryOtlpProtocol"),
    getTelemetryOtlpTracesEndpoint: /* @__PURE__ */ __name(() => telemetry.otlpTracesEndpoint, "getTelemetryOtlpTracesEndpoint"),
    getTelemetryOtlpLogsEndpoint: /* @__PURE__ */ __name(() => telemetry.otlpLogsEndpoint, "getTelemetryOtlpLogsEndpoint"),
    getTelemetryOtlpMetricsEndpoint: /* @__PURE__ */ __name(() => telemetry.otlpMetricsEndpoint, "getTelemetryOtlpMetricsEndpoint"),
    getTelemetryTarget: /* @__PURE__ */ __name(() => telemetry.target ?? defaults.telemetryTarget, "getTelemetryTarget"),
    getTelemetryOutfile: /* @__PURE__ */ __name(() => telemetry.outfile, "getTelemetryOutfile"),
    getTelemetryIncludeSensitiveSpanAttributes: /* @__PURE__ */ __name(() => telemetry.includeSensitiveSpanAttributes ?? false, "getTelemetryIncludeSensitiveSpanAttributes"),
    getTelemetryResourceAttributes: /* @__PURE__ */ __name(() => ({
      "service.instance.id": daemonSessionId,
      ...telemetry.resourceAttributes ?? {}
    }), "getTelemetryResourceAttributes"),
    getTelemetryMetricsIncludeSessionId: /* @__PURE__ */ __name(() => telemetry.metrics?.includeSessionId ?? false, "getTelemetryMetricsIncludeSessionId"),
    getTelemetryResourceAttributeWarnings: /* @__PURE__ */ __name(() => telemetry.resourceAttributeWarnings ?? [], "getTelemetryResourceAttributeWarnings"),
    getCliVersion: /* @__PURE__ */ __name(() => cliVersion, "getCliVersion"),
    getSessionId: /* @__PURE__ */ __name(() => daemonSessionId, "getSessionId"),
    isInteractive: /* @__PURE__ */ __name(() => false, "isInteractive"),
    getOutboundCorrelationPropagateTraceContext: /* @__PURE__ */ __name(() => false, "getOutboundCorrelationPropagateTraceContext")
  };
}
__name(createDaemonTelemetryRuntimeConfig, "createDaemonTelemetryRuntimeConfig");
var InvalidPolicyConfigError = class extends Error {
  static {
    __name(this, "InvalidPolicyConfigError");
  }
  name = "InvalidPolicyConfigError";
  constructor(message) {
    super(message);
  }
};
function validatePolicyConfig(policyConfig = {}, onWarning = writeStderrLine) {
  const validSet = new Set(
    SERVE_CAPABILITY_REGISTRY.permission_mediation.modes
  );
  const permissionStrategy = policyConfig.permissionStrategy;
  const consensusQuorum = policyConfig.consensusQuorum;
  if (permissionStrategy !== void 0 && (typeof permissionStrategy !== "string" || !validSet.has(permissionStrategy))) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.permissionStrategy "${String(permissionStrategy)}"; must be one of ${Array.from(validSet).join(", ")}`
    );
  }
  if (consensusQuorum !== void 0 && (typeof consensusQuorum !== "number" || !Number.isInteger(consensusQuorum) || consensusQuorum < 1)) {
    throw new InvalidPolicyConfigError(
      `qwen serve: invalid policy.consensusQuorum ${String(consensusQuorum)}; must be a positive integer`
    );
  }
  const consensusQuorumActive = consensusQuorum !== void 0 && permissionStrategy === "consensus";
  if (consensusQuorum !== void 0 && permissionStrategy !== "consensus") {
    onWarning(
      'qwen serve: policy.consensusQuorum is set but policy.permissionStrategy is not "consensus"; the override will be ignored.'
    );
  }
  return {
    permissionPolicy: permissionStrategy,
    permissionConsensusQuorum: consensusQuorumActive ? consensusQuorum : void 0
  };
}
__name(validatePolicyConfig, "validatePolicyConfig");
function formatHostForUrl(host) {
  if (host.startsWith("[")) return host;
  if (host.includes(":")) {
    const encoded = host.includes("%") ? host.replace(/%/g, "%25") : host;
    return `[${encoded}]`;
  }
  return host;
}
__name(formatHostForUrl, "formatHostForUrl");
function workspaceRuntimeEffectiveEnv(runtime, daemonEnv) {
  if (runtime.env.mode === "runtime-overlay") {
    return runtime.env.effectiveEnv ?? {};
  }
  return runtime.env.effectiveEnv ?? daemonEnv;
}
__name(workspaceRuntimeEffectiveEnv, "workspaceRuntimeEffectiveEnv");
function canonicalIpLiteral(host) {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  try {
    const hostname = new URL(
      `http://${inner.includes(":") ? `[${inner}]` : inner}`
    ).hostname;
    const canonical = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return isIP(canonical) === 0 ? void 0 : canonical;
  } catch {
    return void 0;
  }
}
__name(canonicalIpLiteral, "canonicalIpLiteral");
function formatChannelWorkerDaemonUrl(host, port, tls = false, ipv6LoopbackAssigned = hostAssignsIpv6Loopback()) {
  const scheme = tls ? "https" : "http";
  const normalized = host.trim().toLowerCase();
  const canonicalIp = canonicalIpLiteral(normalized);
  const v6Loopback = ipv6LoopbackAssigned ? `${scheme}://[::1]:${port}` : `${scheme}://127.0.0.1:${port}`;
  if (canonicalIp === "::") {
    return v6Loopback;
  }
  if (canonicalIp === "0.0.0.0" || canonicalIp === "::ffff:0:0") {
    return `${scheme}://127.0.0.1:${port}`;
  }
  return `${scheme}://${formatHostForUrl(host)}:${port}`;
}
__name(formatChannelWorkerDaemonUrl, "formatChannelWorkerDaemonUrl");
function assertChannelWorkerDaemonUrlIsLocal(workerDaemonUrl, hostname) {
  let host;
  try {
    host = new URL(workerDaemonUrl).hostname;
  } catch {
    throw new Error(
      `Channels cannot start: --hostname "${hostname}" cannot be carried in a worker URL (a zone-scoped address has no spelling the URL parser accepts). Bind to loopback, to the wildcard (0.0.0.0 / ::), or to a zone-less literal address of one of this machine's interfaces.`
    );
  }
  if (isLoopbackBind(host)) return;
  if (isOwnInterfaceAddress(host)) return;
  throw new Error(
    `Channels cannot start: --hostname "${hostname}" is not a loopback bind and does not name an address on this host, so channel workers have no local URL to reach the daemon on. Bind to loopback, to the wildcard (0.0.0.0 / ::), or to a literal address of one of this machine's interfaces.`
  );
}
__name(assertChannelWorkerDaemonUrlIsLocal, "assertChannelWorkerDaemonUrlIsLocal");
var WORKER_TLS_TRUST_PROBE = `
import { isIP } from 'node:net';
import * as tls from 'node:tls';
const url = new URL(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const hostname = url.hostname.replace(/^\\[|\\]$/g, '');
let socket;
let settled = false;
const finish = (result) => {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify(result));
  socket?.destroy();
};
try {
  socket = tls.connect({
    host: hostname,
    port: Number(url.port || '443'),
    rejectUnauthorized: true,
    ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
  }, () => finish({ ok: true }));
  socket.once('error', (error) => finish({
    ok: false,
    code: error.code ?? 'WORKER_TLS_VERIFY_FAILED',
    message: error.message,
  }));
  socket.setTimeout(timeoutMs, () => finish({
    ok: false,
    code: 'WORKER_TLS_VERIFY_TIMEOUT',
    message: 'TLS verification probe timed out.',
  }));
} catch (error) {
  finish({
    ok: false,
    code: error.code ?? 'WORKER_TLS_VERIFY_FAILED',
    message: error.message,
  });
}
`;
async function verifyWorkerTlsTrust(opts) {
  const timeoutMs = opts.timeoutMs ?? 5e3;
  return new Promise((resolve3) => {
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        WORKER_TLS_TRUST_PROBE,
        opts.daemonUrl,
        String(timeoutMs)
      ],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: opts.caCertPath
        },
        encoding: "utf8",
        timeout: timeoutMs + 1e3
      },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          resolve3(result.ok ? void 0 : result);
        } catch {
          const failure = error;
          resolve3({
            code: failure?.code != null ? String(failure.code) : "WORKER_TLS_VERIFY_FAILED",
            message: failure?.message ?? "TLS verification probe failed."
          });
        }
      }
    );
  });
}
__name(verifyWorkerTlsTrust, "verifyWorkerTlsTrust");
function describeWorkerTlsTrustGaps(opts) {
  const chain = parseCertChain(opts.cert);
  const x509 = bootParsedLeaf(opts.cert);
  if (!x509) {
    return [];
  }
  const gaps = [];
  const operatorChain = opts.operatorCaCert ? loadableCertificates(
    opts.operatorCaCert.toString("utf8"),
    opts.operatorCaCertSourcePath
  ) : void 0;
  const servingBlocks = loadableCertificates(
    opts.cert.toString("utf8"),
    opts.certSourcePath
  );
  const operatorDiscarded = !servingBlocks && operatorChain !== void 0;
  const servingChain = servingBlocks === void 0 ? [
    x509,
    ...chain.filter(
      (member) => member.fingerprint256 !== x509.fingerprint256
    )
  ] : (
    // The loader can read blocks out of the file and still not read the
    // block the daemon SERVES — a leaf exported by `openssl x509
    // -trustout` carries the `TRUSTED CERTIFICATE` label, which is not one
    // the loader takes a certificate from, so a `trusted leaf + plain root`
    // serving file yields `servingBlocks = [root]`. Starting the walk at
    // that root put it at depth 0, where the leaf-depth exemption below
    // waives the CA-capability check, and the walk returned anchored with
    // zero gaps: measured `gaps: []` at boot for a CA:FALSE root
    // (handshake INVALID_PURPOSE) and for a CA:TRUE root without
    // keyCertSign (handshake UNSPECIFIED), while `createSecureContext`
    // accepts the file and the daemon boots green and silent.
    //
    // So anchor the walk at the certificate boot parsed, the way the
    // `servingBlocks === undefined` fallback above already does; the
    // remaining blocks supply the rest of the chain.
    servingBlocks.some(
      (block) => block.fingerprint256 === x509.fingerprint256
    ) ? servingBlocks : [x509, ...servingBlocks]
  );
  const leafHeldByWorkers = servingBlocks !== void 0 && servingBlocks.some((block) => block.fingerprint256 === x509.fingerprint256);
  const workerTrustStore = operatorChain && servingBlocks ? [...operatorChain, ...servingChain] : servingChain;
  const now = Date.now();
  const anchorPath = walkWorkerAnchorPath(
    x509,
    workerTrustStore,
    now,
    // The `servingBlocks === undefined` fallback prepends the leaf too, but
    // that file already reports its own gap below and the workers receive it
    // verbatim; only the partial-read case needs the distinction.
    servingBlocks === void 0 || leafHeldByWorkers
  );
  if (opts.operatorCaCertReadError !== void 0) {
    const servingFallbackAnchors = anchorPath.anchored && servingBlocks !== void 0;
    gaps.push(
      `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" could not be read by the daemon (${opts.operatorCaCertReadError}), so channel workers receive no CA from it \u2014 a root-owned or mode-600 file is the usual cause, and its contents are not the problem. ` + (servingFallbackAnchors ? `--tls-cert "${opts.certPath}" carries an anchor of its own, and that file is what the workers fall back to, so their trust does not rest on this one today \u2014 whatever it was meant to add reaches nobody. Fix that file's permissions or path and restart.` : servingBlocks === void 0 ? `--tls-cert "${opts.certPath}" itself holds no block the workers' loader can read, so their fallback bundle is that file alone and it anchors nothing \u2014 fixing this CA file's permissions changes nothing; re-export the serving file as the gap below describes and restart.` : `Every worker handshake to the daemon will fail UNABLE_TO_VERIFY_LEAF_SIGNATURE unless the issuing CA is already in the workers' default trust store. Fix that file's permissions or path and restart.`)
    );
  } else if (opts.operatorCaCert && !operatorChain) {
    gaps.push(
      `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" holds no PEM certificate block Node's loader can read \u2014 every -----BEGIN/END CERTIFICATE----- marker must sit alone on its own line and every block must decode, and a DER file is never read at all. Channel workers therefore receive the daemon cert alone and anchor nothing through this file. Re-export it as PEM and restart.`
    );
  }
  if (!servingBlocks) {
    gaps.push(
      `--tls-cert "${opts.certPath}" holds no PEM certificate block Node's loader can read, so ` + (operatorDiscarded ? `the channel workers' bundle cannot be merged: they receive that file alone and NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" is discarded. ` : `the channel workers receive a bundle their loader takes nothing from. `) + `Every worker handshake to the daemon will fail UNABLE_TO_VERIFY_LEAF_SIGNATURE. Re-export --tls-cert as PEM with every -----BEGIN/END CERTIFICATE----- marker alone on its own line and restart.`
    );
  }
  const leafPurposeDefect = tlsServerPurposeDefect(x509);
  if (leafPurposeDefect) {
    gaps.push(
      `--tls-cert "${opts.certPath}" cannot be used as a TLS server certificate because ${leafPurposeDefect}. Every worker handshake to the daemon will fail INVALID_PURPOSE. Reissue the leaf with a TLS-server keyUsage and serverAuth extendedKeyUsage, then restart.`
    );
  }
  if (anchorPath.nonCaTerminator) {
    const terminatorSubject = anchorPath.nonCaTerminator.subject.replace(
      /\r?\n/g,
      ", "
    );
    gaps.push(
      issuerRefusedForKeyUsage(anchorPath.nonCaTerminator) ? `--tls-cert "${opts.certPath}" chains up to "${terminatorSubject}", which is self-signed but whose keyUsage does not include keyCertSign, so OpenSSL refuses to let it issue the certificates below it however its basicConstraints reads. Every worker handshake to the daemon will fail "key usage does not include certificate signing" even though the chain terminates on a self-signed certificate. Reissue that certificate with keyCertSign in its keyUsage and restart \u2014 CA:TRUE alone does not fix it, and no NODE_EXTRA_CA_CERTS can anchor a self-signed certificate through anything but itself.` : `--tls-cert "${opts.certPath}" chains up to "${terminatorSubject}", which is self-signed but is not a CA \u2014 it carries basicConstraints CA:FALSE or, as an X.509 v3 certificate, no basicConstraints at all, and OpenSSL refuses to let it issue the certificates below it, so every worker handshake to the daemon will fail INVALID_PURPOSE ("unsuitable certificate purpose"). Reissue that certificate with CA:TRUE, or point NODE_EXTRA_CA_CERTS at a real CA that anchors the chain, and restart.`
    );
  } else if (anchorPath.incapableIssuer) {
    const keyUsageIsTheCause = issuerRefusedForKeyUsage(
      anchorPath.incapableIssuer
    );
    gaps.push(
      `--tls-cert "${opts.certPath}" chains through "${anchorPath.incapableIssuer.subject.replace(/\r?\n/g, ", ")}", ` + (keyUsageIsTheCause ? `whose keyUsage does not include keyCertSign, so OpenSSL refuses to let it issue the certificate below it however its basicConstraints reads. Every worker handshake to the daemon will fail with an invalid-CA error even though the chain looks complete, and the issuing CA IS in their bundle. Reissue that intermediate with keyCertSign in its keyUsage and restart \u2014 pointing NODE_EXTRA_CA_CERTS elsewhere cannot fix it.` : `which is not a CA \u2014 it carries basicConstraints CA:FALSE or, as an X.509 v3 certificate, no basicConstraints at all, and OpenSSL refuses to let it issue the certificate below it. Every worker handshake to the daemon will fail INVALID_PURPOSE or INVALID_CA even though the chain looks complete. Reissue that intermediate with CA:TRUE, or point NODE_EXTRA_CA_CERTS at a chain whose intermediates are real CAs, and restart.`)
    );
  } else if (anchorPath.pathLengthViolation) {
    const { cert, constraint } = anchorPath.pathLengthViolation;
    gaps.push(
      `--tls-cert "${opts.certPath}" chains through "${cert.subject.replace(/\r?\n/g, ", ")}", whose basicConstraints carries pathlen:${constraint} \u2014 it permits at most ${constraint} intermediate CA${constraint === 1 ? "" : "s"} below it, and this chain has more. Every worker handshake to the daemon will fail PATH_LENGTH_EXCEEDED even though every certificate in the bundle verifies. Reissue that CA with a pathlen that covers the chain, or shorten the chain, and restart.`
    );
  } else if (anchorPath.unheldSelfSignedLeaf) {
    gaps.push(
      `--tls-cert "${opts.certPath}" serves a self-signed certificate whose own PEM block is not one Node's NODE_EXTRA_CA_CERTS loader takes (a -----BEGIN TRUSTED CERTIFICATE----- block, as \`openssl x509 -trustout\` writes, is the usual cause), so the channel workers never receive that certificate \u2014 and a self-signed certificate verifies only when it is itself in the trust store. The daemon serves it fine, but every worker handshake will fail DEPTH_ZERO_SELF_SIGNED_CERT with nothing logged. Re-export --tls-cert with a plain -----BEGIN CERTIFICATE----- block and restart.`
    );
  } else if (!anchorPath.anchored) {
    gaps.push(
      `--tls-cert "${opts.certPath}" is issued by another CA (${x509.issuer.replace(/\r?\n/g, ", ")}), not self-signed, and ${!opts.operatorCaCertPath ? `no NODE_EXTRA_CA_CERTS is set` : opts.operatorCaCertReadError !== void 0 ? `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" could not be read, so whatever it carries reached nobody` : operatorDiscarded ? `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" was discarded together with the unloadable serving file above, whatever it carries` : `NODE_EXTRA_CA_CERTS "${opts.operatorCaCertPath}" does not carry a certificate that anchors it`}, so nothing in the channel workers' bundle anchors their trust \u2014 every worker handshake to the daemon will fail UNABLE_TO_VERIFY_LEAF_SIGNATURE unless the issuing CA is already in the workers' default trust store. ` + (operatorDiscarded ? `Re-export --tls-cert as described above and restart; NODE_EXTRA_CA_CERTS is not the file to change.` : opts.operatorCaCertReadError !== void 0 ? `Make NODE_EXTRA_CA_CERTS readable by the daemon as described above and restart.` : `Point NODE_EXTRA_CA_CERTS at the issuing CA (for mkcert: "$(mkcert -CAROOT)/rootCA.pem") and restart.`)
    );
  }
  for (const member of anchorPath.path) {
    if (member.fingerprint256 === x509.fingerprint256) continue;
    const subject = member.subject.replace(/\r?\n/g, ", ");
    if (member.keyUsage && !member.keyUsage.includes(TLS_SERVER_AUTH_OID)) {
      gaps.push(
        `--tls-cert "${opts.certPath}" chains through "${subject}", whose extendedKeyUsage does not include serverAuth \u2014 every worker handshake to the daemon will fail INVALID_PURPOSE. Reissue that chain member with serverAuth in its extendedKeyUsage and restart.`
      );
      continue;
    }
    if (!certValidAt(member, now)) {
      if (new Date(member.validTo).getTime() < now) {
        gaps.push(
          `--tls-cert "${opts.certPath}" chains through "${subject}", which expired on ${member.validTo} \u2014 every worker handshake to the daemon will fail CERT_HAS_EXPIRED. Renew that chain member and restart.`
        );
      } else {
        gaps.push(
          `--tls-cert "${opts.certPath}" chains through "${subject}", which is not yet valid (validFrom: ${member.validFrom}) \u2014 every worker handshake to the daemon will fail CERT_NOT_YET_VALID. Check that chain member's notBefore date or the system clock.`
        );
      }
    }
  }
  const host = workerDialHost(opts.daemonUrl);
  if (host && !certCoversHost(x509, host)) {
    gaps.push(
      `--tls-cert "${opts.certPath}" has no subjectAltName covering "${host}", the host channel workers dial \u2014 every worker handshake will fail ERR_TLS_CERT_ALTNAME_INVALID. Reissue the certificate with that host in its SANs and restart.`
    );
  }
  return gaps;
}
__name(describeWorkerTlsTrustGaps, "describeWorkerTlsTrustGaps");
var BASIC_CONSTRAINTS_OID = Buffer.from([85, 29, 19]);
var KEY_USAGE_OID = Buffer.from([85, 29, 15]);
var KEY_CERT_SIGN_MASK = 4;
var TLS_SERVER_KEY_USAGE_MASK = 168;
var TLS_SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
var VERSION_TAG = 160;
var EXTENSIONS_TAG = 163;
var SEQUENCE_TAG = 48;
var BOOLEAN_TAG = 1;
var INTEGER_TAG = 2;
function derElementAt(der, at) {
  const tag = der[at];
  const header = der[at + 1];
  if (tag === void 0 || header === void 0) return void 0;
  let start = at + 2;
  let length = header & 127;
  if ((header & 128) !== 0) {
    if (length === 0 || length > 4) return void 0;
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      const byte = der[start + index];
      if (byte === void 0) return void 0;
      value = value * 256 + byte;
    }
    start += length;
    length = value;
  }
  const end = start + length;
  return end <= der.length ? { tag, start, end } : void 0;
}
__name(derElementAt, "derElementAt");
function tbsCertificateOf(cert) {
  const certificate = derElementAt(cert.raw, 0);
  if (certificate?.tag !== SEQUENCE_TAG) return void 0;
  const tbs = derElementAt(cert.raw, certificate.start);
  return tbs?.tag === SEQUENCE_TAG ? tbs : void 0;
}
__name(tbsCertificateOf, "tbsCertificateOf");
function certificateExtension(cert, oid) {
  const der = cert.raw;
  const tbs = tbsCertificateOf(cert);
  if (!tbs) return void 0;
  let at = tbs.start;
  while (at < tbs.end) {
    const member = derElementAt(der, at);
    if (!member) return void 0;
    if (member.tag !== EXTENSIONS_TAG) {
      at = member.end;
      continue;
    }
    const list = derElementAt(der, member.start);
    if (list?.tag !== SEQUENCE_TAG) return void 0;
    let entry = list.start;
    while (entry < list.end) {
      const extension = derElementAt(der, entry);
      if (extension?.tag !== SEQUENCE_TAG) return void 0;
      const id = derElementAt(der, extension.start);
      if (!id) return void 0;
      let valueAt = id.end;
      const critical = derElementAt(der, valueAt);
      if (critical?.tag === BOOLEAN_TAG) valueAt = critical.end;
      const value = derElementAt(der, valueAt);
      if (!value) return void 0;
      if (der.subarray(id.start, id.end).equals(oid)) {
        return der.subarray(value.start, value.end);
      }
      entry = extension.end;
    }
    return void 0;
  }
  return void 0;
}
__name(certificateExtension, "certificateExtension");
function keyUsageAllowsCertSign(der) {
  const bits = derElementAt(der, 0);
  if (!bits) return false;
  const first = der[bits.start + 1];
  return first !== void 0 && (first & KEY_CERT_SIGN_MASK) !== 0;
}
__name(keyUsageAllowsCertSign, "keyUsageAllowsCertSign");
function tlsServerPurposeDefect(cert) {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  if (keyUsage !== void 0) {
    const bits = derElementAt(keyUsage, 0);
    const first = bits ? keyUsage[bits.start + 1] : void 0;
    if (first === void 0 || (first & TLS_SERVER_KEY_USAGE_MASK) === 0) {
      return "its keyUsage permits none of digitalSignature, keyEncipherment, or keyAgreement";
    }
  }
  if (cert.keyUsage && !cert.keyUsage.includes(TLS_SERVER_AUTH_OID)) {
    return "its extendedKeyUsage does not include serverAuth";
  }
  return void 0;
}
__name(tlsServerPurposeDefect, "tlsServerPurposeDefect");
function isV1Certificate(cert) {
  const tbs = tbsCertificateOf(cert);
  return tbs !== void 0 && cert.raw[tbs.start] !== VERSION_TAG;
}
__name(isV1Certificate, "isV1Certificate");
function cannotIssueCertificates(cert) {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  if (keyUsage !== void 0 && !keyUsageAllowsCertSign(keyUsage)) return true;
  if (certificateExtension(cert, BASIC_CONSTRAINTS_OID) !== void 0) {
    return !cert.ca;
  }
  return !isV1Certificate(cert) && keyUsage === void 0;
}
__name(cannotIssueCertificates, "cannotIssueCertificates");
function certValidAt(cert, now) {
  return new Date(cert.validFrom).getTime() <= now && new Date(cert.validTo).getTime() >= now;
}
__name(certValidAt, "certValidAt");
function isSelfSignedCert(x509) {
  if (x509.subject !== x509.issuer) return false;
  try {
    return x509.verify(x509.publicKey);
  } catch {
    return true;
  }
}
__name(isSelfSignedCert, "isSelfSignedCert");
var PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g;
function parseCertChain(cert) {
  const blocks = cert.toString("utf8").match(PEM_CERTIFICATE_BLOCK);
  if (!blocks) {
    try {
      return [new X509Certificate(cert)];
    } catch {
      return [];
    }
  }
  const chain = [];
  for (const block of blocks) {
    try {
      chain.push(new X509Certificate(block));
    } catch {
    }
  }
  return chain;
}
__name(parseCertChain, "parseCertChain");
function bootParsedLeaf(cert) {
  try {
    return new X509Certificate(cert);
  } catch {
    return void 0;
  }
}
__name(bootParsedLeaf, "bootParsedLeaf");
function certIssuedBy(cert, issuer) {
  try {
    return cert.issuer === issuer.subject && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}
__name(certIssuedBy, "certIssuedBy");
function issuerRefusedForKeyUsage(cert) {
  const keyUsage = certificateExtension(cert, KEY_USAGE_OID);
  return keyUsage !== void 0 && !keyUsageAllowsCertSign(keyUsage);
}
__name(issuerRefusedForKeyUsage, "issuerRefusedForKeyUsage");
function pathLengthConstraint(cert) {
  const value = certificateExtension(cert, BASIC_CONSTRAINTS_OID);
  if (!value) return void 0;
  const sequence = derElementAt(value, 0);
  if (sequence?.tag !== SEQUENCE_TAG) return void 0;
  let at = sequence.start;
  const first = derElementAt(value, at);
  if (!first) return void 0;
  if (first.tag === BOOLEAN_TAG) at = first.end;
  const integer = derElementAt(value, at);
  if (integer?.tag !== INTEGER_TAG) return void 0;
  let length = 0;
  for (let index = integer.start; index < integer.end; index += 1) {
    const byte = value[index];
    if (byte === void 0) return void 0;
    length = length * 256 + byte;
  }
  return length;
}
__name(pathLengthConstraint, "pathLengthConstraint");
function walkWorkerAnchorPath(leaf, chain, now, leafHeldByWorkers = true) {
  let next = leaf;
  const walked = /* @__PURE__ */ new Set();
  const path2 = [];
  let pathLengthViolation;
  while (next) {
    const current = next;
    path2.push(current);
    if (path2.length > 1 && pathLengthViolation === void 0) {
      const constraint = pathLengthConstraint(current);
      const intermediatesBelow = path2.length - 2;
      if (constraint !== void 0 && intermediatesBelow > constraint) {
        pathLengthViolation = { cert: current, constraint };
      }
    }
    if (isSelfSignedCert(current)) {
      if (path2.length > 1 && cannotIssueCertificates(current)) {
        return { anchored: false, path: path2, nonCaTerminator: current };
      }
      if (path2.length === 1 && !leafHeldByWorkers) {
        return { anchored: false, path: path2, unheldSelfSignedLeaf: current };
      }
      return pathLengthViolation ? { anchored: false, path: path2, pathLengthViolation } : { anchored: true, path: path2 };
    }
    walked.add(current.fingerprint256);
    const issuers = chain.filter(
      (candidate) => !walked.has(candidate.fingerprint256) && certIssuedBy(current, candidate)
    );
    const issuer = issuers.find((candidate) => certValidAt(candidate, now)) ?? issuers[0];
    if (issuer && !isSelfSignedCert(issuer) && !issuer.ca) {
      return { anchored: false, path: path2, incapableIssuer: issuer };
    }
    next = issuer;
  }
  return pathLengthViolation ? { anchored: false, path: path2, pathLengthViolation } : { anchored: false, path: path2 };
}
__name(walkWorkerAnchorPath, "walkWorkerAnchorPath");
function workerDialHost(daemonUrl) {
  try {
    const hostname = new URL(daemonUrl).hostname;
    if (!hostname) return void 0;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  } catch {
    return void 0;
  }
}
__name(workerDialHost, "workerDialHost");
function certCoversHost(x509, host) {
  try {
    return isIP(host) ? Boolean(x509.checkIP(host)) : Boolean(x509.checkHost(host));
  } catch {
    return true;
  }
}
__name(certCoversHost, "certCoversHost");
function extractContextFilename(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? void 0 : trimmed;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed !== "") return trimmed;
      }
    }
    return void 0;
  }
  return void 0;
}
__name(extractContextFilename, "extractContextFilename");
function sessionArtifactsPersistenceAvailableFromSettings(settings) {
  return settings?.general?.chatRecording !== false;
}
__name(sessionArtifactsPersistenceAvailableFromSettings, "sessionArtifactsPersistenceAvailableFromSettings");
function subSessionConcurrencyCapsFromSettings(serve, onWarning = writeStderrLine) {
  const asCap = /* @__PURE__ */ __name((key, value) => {
    if (value === void 0) return void 0;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      return value;
    }
    onWarning(
      `qwen serve: ignoring invalid ${key} (${JSON.stringify(value)}); expected a positive integer, falling back to the built-in default.`
    );
    return void 0;
  }, "asCap");
  const maxConcurrentPerCaller = asCap(
    "maxConcurrentSubSessionsPerCaller",
    serve.maxConcurrentSubSessionsPerCaller
  );
  const maxConcurrentTotal = asCap(
    "maxConcurrentSubSessionsTotal",
    serve.maxConcurrentSubSessionsTotal
  );
  return {
    ...maxConcurrentPerCaller !== void 0 ? { maxConcurrentPerCaller } : {},
    ...maxConcurrentTotal !== void 0 ? { maxConcurrentTotal } : {}
  };
}
__name(subSessionConcurrencyCapsFromSettings, "subSessionConcurrencyCapsFromSettings");
var settingsWriteLocks = /* @__PURE__ */ new Map();
function withSettingsLock(workspace, fn) {
  const prev = settingsWriteLocks.get(workspace) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  settingsWriteLocks.set(workspace, next);
  return next;
}
__name(withSettingsLock, "withSettingsLock");
var retryableChannelWorkerShutdownErrors = /* @__PURE__ */ new WeakSet();
function hasRetryableChannelWorkerShutdownError(error) {
  if (error instanceof AggregateError) {
    return error.errors.some(hasRetryableChannelWorkerShutdownError);
  }
  return error instanceof Error && retryableChannelWorkerShutdownErrors.has(error);
}
__name(hasRetryableChannelWorkerShutdownError, "hasRetryableChannelWorkerShutdownError");
var channelWorkerRuntimePromise;
async function loadChannelWorkerRuntime() {
  channelWorkerRuntimePromise ??= Promise.all([
    import("./channel-worker-supervisor-VYTODSJU.js"),
    import("./pidfile-EQXMRWBV.js"),
    import("./runtime-ABQVBBH3.js"),
    import("./cli-entry-path-4VJ3Y6T2.js"),
    import("./channel-worker-group-IELLDEGR.js"),
    import("./channel-worker-manager-SG6BXDVI.js")
  ]).then(
    ([
      supervisor,
      pidfile,
      channelRuntime,
      cliEntryPath,
      workerGroup,
      workerManager
    ]) => ({
      createChannelWorkerSupervisor: supervisor.createChannelWorkerSupervisor,
      resolveWorkerCaCertPath: supervisor.resolveWorkerCaCertPath,
      channelServicePidfile: pidfile,
      loadChannelsConfig: channelRuntime.loadChannelsConfig,
      createChannelWorkerGroup: workerGroup.createChannelWorkerGroup,
      createChannelWorkerManager: workerManager.createChannelWorkerManager,
      findCliEntryPath: cliEntryPath.findCliEntryPath
    })
  ).catch((err) => {
    channelWorkerRuntimePromise = void 0;
    throw err;
  });
  return channelWorkerRuntimePromise;
}
__name(loadChannelWorkerRuntime, "loadChannelWorkerRuntime");
function createDisabledChannelWorkerSupervisor() {
  const snapshot = {
    enabled: false,
    state: "disabled",
    channels: []
  };
  return {
    async start() {
    },
    async stop() {
    },
    async restart() {
      return { ...snapshot, channels: [] };
    },
    killAllSync() {
    },
    snapshot: /* @__PURE__ */ __name(() => ({ ...snapshot, channels: [] }), "snapshot"),
    async enqueueWebhookTask() {
      throw new ChannelWebhookEnqueueError(
        "channel_worker_unavailable",
        "Channel worker is not running."
      );
    }
  };
}
__name(createDisabledChannelWorkerSupervisor, "createDisabledChannelWorkerSupervisor");
function writeServeChannelReservation(channelServicePidfile, channels) {
  channelServicePidfile.reserveServeServiceInfo({
    channels,
    servePid: process.pid
  });
}
__name(writeServeChannelReservation, "writeServeChannelReservation");
function channelServicePidfileConflictError(info) {
  const owner = info.owner === "serve" ? "qwen serve" : "qwen channel start";
  return Object.assign(
    new Error(
      `Channel service is already running under ${owner} (PID ${info.pid}). Stop it before enabling daemon-managed channels.`
    ),
    { code: "channel_service_conflict", owner: info.owner, pid: info.pid }
  );
}
__name(channelServicePidfileConflictError, "channelServicePidfileConflictError");
function channelServiceStartingConflictError() {
  return Object.assign(
    new Error(
      "Channel service is already starting. Retry after the current startup finishes."
    ),
    { code: "channel_service_conflict" }
  );
}
__name(channelServiceStartingConflictError, "channelServiceStartingConflictError");
function normalizeInstallModelIds(req, provider, getDefaultModelIds) {
  const fromRequest = req.modelIds?.map((id) => id.trim()).filter((id) => id.length > 0);
  const modelIds = fromRequest && fromRequest.length > 0 ? fromRequest : getDefaultModelIds(provider);
  return [...new Set(modelIds)];
}
__name(normalizeInstallModelIds, "normalizeInstallModelIds");
function buildProviderSetupInputs(req, provider, helpers) {
  const protocol = req.protocol ?? provider.protocol;
  const baseUrl = helpers.resolveBaseUrl(provider, req.baseUrl);
  return {
    ...provider.protocolOptions ? { protocol } : {},
    ...req.wireApi ? { wireApi: req.wireApi } : {},
    baseUrl,
    apiKey: req.apiKey.trim(),
    modelIds: normalizeInstallModelIds(
      req,
      provider,
      helpers.getDefaultModelIds
    ),
    ...req.advancedConfig ? { advancedConfig: req.advancedConfig } : {}
  };
}
__name(buildProviderSetupInputs, "buildProviderSetupInputs");
function shouldPreheatBridge(deps) {
  if (deps.preheatBridge !== void 0) return deps.preheatBridge;
  return process.env["VITEST_WORKER_ID"] === void 0;
}
__name(shouldPreheatBridge, "shouldPreheatBridge");
var coreRuntimePromise;
function loadCoreRuntime() {
  coreRuntimePromise ??= import("./core-runtime-4FG42WNR.js");
  return coreRuntimePromise;
}
__name(loadCoreRuntime, "loadCoreRuntime");
var liveDiscoveryRuntimePromise;
function loadLiveDiscoveryRuntime() {
  liveDiscoveryRuntimePromise ??= import("./discovery-5KUEPR65.js");
  return liveDiscoveryRuntimePromise;
}
__name(loadLiveDiscoveryRuntime, "loadLiveDiscoveryRuntime");
async function resolveDaemonLogBaseDirForRun(input) {
  if (input.deps.daemonLogBaseDir) {
    return input.deps.daemonLogBaseDir;
  }
  if (input.deps.bootSettings === void 0) {
    const core2 = await loadCoreRuntime();
    if (core2.Storage.getRuntimeBaseDir() !== core2.Storage.getGlobalQwenDir()) {
      return core2.Storage.getGlobalDebugDir();
    }
  }
  if (input.bootSettings?.advanced?.runtimeOutputDir !== void 0) {
    return resolveDaemonLogBaseDir(
      input.bootSettings.advanced.runtimeOutputDir,
      input.boundWorkspace
    );
  }
  if (input.deps.bootSettings !== void 0) {
    return resolveDaemonLogBaseDir(void 0, input.boundWorkspace);
  }
  const core = await loadCoreRuntime();
  return core.Storage.getGlobalDebugDir();
}
__name(resolveDaemonLogBaseDirForRun, "resolveDaemonLogBaseDirForRun");
var settingsRuntimePromise;
function loadSettingsRuntimeModules() {
  settingsRuntimePromise ??= Promise.all([
    import("./settings-K2CRMBUO.js"),
    import("./environment-EDMUOCI7.js"),
    import("./loadedSettingsAdapter-N5HR625O.js"),
    import("./trustedFolders-ZP6QHK7A.js")
  ]).then(([settings, environment, loadedSettingsAdapter, trustedFolders]) => ({
    settings,
    environment,
    loadedSettingsAdapter,
    trustedFolders
  }));
  return settingsRuntimePromise;
}
__name(loadSettingsRuntimeModules, "loadSettingsRuntimeModules");
var channelWebhookConfigRuntimePromise;
function loadChannelWebhookConfigRuntime() {
  channelWebhookConfigRuntimePromise ??= Promise.all([
    import("./runtime-ABQVBBH3.js"),
    import("./config-utils-6XQZ55NC.js")
  ]).then(([channelRuntime, configUtils]) => ({
    loadChannelsConfig: channelRuntime.loadChannelsConfig,
    parseChannelWebhookConfig: configUtils.parseChannelWebhookConfig
  })).catch((err) => {
    channelWebhookConfigRuntimePromise = void 0;
    throw err;
  });
  return channelWebhookConfigRuntimePromise;
}
__name(loadChannelWebhookConfigRuntime, "loadChannelWebhookConfigRuntime");
async function loadServeRuntimeModules() {
  const [
    serverModule,
    bridgeModule,
    spawnChannelModule,
    processRegistryModule,
    workspaceModule,
    workspaceTypesModule,
    daemonStatusProviderModule,
    workspaceProvidersStatusModule,
    workspaceSkillsStatusModule,
    totalSessionAdmissionModule,
    workspaceRegistryModule,
    workspaceRuntimeCoordinatorModule,
    promptLedgerModule
  ] = await Promise.all([
    import("./server-3ZKOUV6V.js"),
    import("./bridge-MADYRCOB.js"),
    import("./spawnChannel-F5V6MZZC.js"),
    import("./process-registry-7LAPI3ZB.js"),
    import("./workspace-service-OZQHFLTR.js"),
    import("./types-HKLPXZB3.js"),
    import("./daemon-status-provider-23O57WFY.js"),
    import("./workspace-providers-status-FHUYIET3.js"),
    import("./workspace-skills-status-MR4GUOOV.js"),
    import("./total-session-admission-ZVJBO5TJ.js"),
    import("./workspace-registry-ATS35M7C.js"),
    import("./workspace-runtime-coordinator-25WUGMUG.js"),
    import("./prompt-terminal-ledger-TY5OIXXQ.js")
  ]);
  return {
    createServeApp: serverModule.createServeApp,
    getActiveSseCount: serverModule.getActiveSseCount,
    resolveBoundWorkspacesFromIdeEnv: serverModule.resolveBoundWorkspacesFromIdeEnv,
    resolveBridgeFsFactory: serverModule.resolveBridgeFsFactory,
    createAcpSessionBridge: bridgeModule.createAcpSessionBridge,
    createSpawnChannelFactory: spawnChannelModule.createSpawnChannelFactory,
    daemonAcpNdJsonLimits: spawnChannelModule.DAEMON_ACP_NDJSON_LIMITS,
    ProcessRegistry: processRegistryModule.ProcessRegistry,
    createDaemonWorkspaceService: workspaceModule.createDaemonWorkspaceService,
    WorkspaceSettingsPartialPersistError: workspaceTypesModule.WorkspaceSettingsPartialPersistError,
    createDaemonStatusProvider: daemonStatusProviderModule.createDaemonStatusProvider,
    createWorkspaceProvidersStatusProvider: workspaceProvidersStatusModule.createWorkspaceProvidersStatusProvider,
    createWorkspaceSkillsStatusProvider: workspaceSkillsStatusModule.createWorkspaceSkillsStatusProvider,
    createTotalSessionAdmissionController: totalSessionAdmissionModule.createTotalSessionAdmissionController,
    createWorkspaceRegistry: workspaceRegistryModule.createWorkspaceRegistry,
    createWorkspaceSessionOwnerIndex: workspaceRegistryModule.createWorkspaceSessionOwnerIndex,
    createWorkspaceGenerationGuard: workspaceRegistryModule.createWorkspaceGenerationGuard,
    getWorkspaceRuntimeCoordinatorIfSupported: workspaceRuntimeCoordinatorModule.getWorkspaceRuntimeCoordinatorIfSupported,
    createPromptLedgerSink: promptLedgerModule.createPromptLedgerSink
  };
}
__name(loadServeRuntimeModules, "loadServeRuntimeModules");
function advertisedMaxSessions(value) {
  if (value === void 0) return DEFAULT_MAX_SESSIONS;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}
__name(advertisedMaxSessions, "advertisedMaxSessions");
function advertisedMaxPendingPromptsPerSession(value) {
  if (value === void 0) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}
__name(advertisedMaxPendingPromptsPerSession, "advertisedMaxPendingPromptsPerSession");
function channelIdleTimeoutMs(value) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TIMEOUT_MS) : 0;
}
__name(channelIdleTimeoutMs, "channelIdleTimeoutMs");
function sessionIdleTimeoutMs(value) {
  return value !== void 0 ? channelIdleTimeoutMs(value) : DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}
__name(sessionIdleTimeoutMs, "sessionIdleTimeoutMs");
function sessionPromptSettledCloseGraceMs(value) {
  return value !== void 0 ? channelIdleTimeoutMs(value) : DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS;
}
__name(sessionPromptSettledCloseGraceMs, "sessionPromptSettledCloseGraceMs");
function currentServeFeaturesForRunQwenServe(opts, sessionShellCommandEnabled, sessionArtifactsPersistenceAvailable, workspaceRuntimeAvailable, currentSessionSchedulingAvailable, env, nativeDirectoryPickerAvailable, localPathOpenAvailable, localTerminalOpenAvailable) {
  return getAdvertisedServeFeatures(void 0, {
    requireAuth: opts.requireAuth === true,
    mcpPoolActive: opts.mcpPoolActive !== false,
    externalToolGuardActive: opts.externalToolGuard?.mode === "required",
    allowOriginActive: opts.allowOrigins !== void 0 && opts.allowOrigins.length > 0,
    ...opts.promptDeadlineMs !== void 0 ? { promptDeadlineMs: opts.promptDeadlineMs } : {},
    ...opts.writerIdleTimeoutMs !== void 0 ? { writerIdleTimeoutMs: opts.writerIdleTimeoutMs } : {},
    persistSettingAvailable: true,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    sessionGenerationAvailable: true,
    currentSessionSchedulingAvailable,
    workspaceGenerationAvailable: true,
    rateLimit: opts.rateLimit === true,
    reloadAvailable: true,
    channelReloadAvailable: opts.channelSelection !== void 0,
    channelControlAvailable: true,
    channelManagementAvailable: true,
    persistentWorkspaceRegistrationAvailable: true,
    workspaceRuntimeRemovalAvailable: true,
    // Advertise the same host-conditional and WS feature flags as the runtime
    // path (serve-features.ts) so the bootstrap `/capabilities` window doesn't
    // briefly under-report them.
    nativeDirectoryPickerAvailable,
    workspaceRuntimeAvailable,
    localPathOpenAvailable,
    localTerminalOpenAvailable,
    // The production wiring below always registers these, so the bootstrap
    // envelope must not under-report them either — the runtime envelope
    // serves all five once the app is up.
    dynamicWorkspaceRegistrationAvailable: true,
    scratchWorkspaceRegistrationAvailable: true,
    standaloneSessionsAvailable: true,
    workspaceTrustHotReloadAvailable: true,
    acpHttpEnabled: resolveAcpHttpEnabled(env),
    clientMcpOverWsEnabled: opts.clientMcpOverWs === true,
    cdpTunnelOverWsEnabled: opts.cdpTunnelOverWs === true,
    browserAutomationMcpAvailable: isBrowserAutomationMcpAvailable(opts, env)
  });
}
__name(currentServeFeaturesForRunQwenServe, "currentServeFeaturesForRunQwenServe");
function createBootstrapCapabilities(input) {
  return {
    v: CAPABILITIES_SCHEMA_VERSION,
    protocolVersions: getServeProtocolVersions(),
    ...input.qwenCodeVersion ? { qwenCodeVersion: input.qwenCodeVersion } : {},
    mode: input.opts.mode,
    features: currentServeFeaturesForRunQwenServe(
      input.opts,
      input.sessionShellCommandEnabled,
      input.sessionArtifactsPersistenceAvailable,
      input.workspaceRuntimeAvailable,
      input.currentSessionSchedulingAvailable,
      input.env,
      input.nativeDirectoryPickerAvailable,
      input.localPathOpenAvailable,
      input.localTerminalOpenAvailable
    ),
    modelServices: [],
    workspaceCwd: input.boundWorkspace,
    transports: ["rest"],
    policy: { permission: input.permissionPolicy ?? "first-responder" },
    limits: {
      maxRegisteredWorkspaces: input.opts.maxRegisteredWorkspaces,
      maxChannelControlWorkspaces: MAX_CHANNEL_CONTROL_WORKSPACES,
      ...input.opts.maxTotalSessions !== void 0 ? {
        maxSessionsPerWorkspace: advertisedMaxSessions(
          input.opts.maxSessions
        ),
        maxTotalSessions: positiveFiniteOrNull(input.opts.maxTotalSessions)
      } : {},
      maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
        input.opts.maxPendingPromptsPerSession
      ),
      sessionRestoreTimeoutMs: resolveSessionRestoreTimeoutMs(input.opts)
    }
  };
}
__name(createBootstrapCapabilities, "createBootstrapCapabilities");
function validateRateLimitOptions(opts) {
  if (opts.rateLimit !== true) return;
  for (const [name, value] of [
    ["rateLimitPrompt", opts.rateLimitPrompt],
    ["rateLimitMutation", opts.rateLimitMutation],
    ["rateLimitRead", opts.rateLimitRead]
  ]) {
    if (value !== void 0 && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
      throw new TypeError(
        `Invalid ${name}: ${value}. Must be a positive integer.`
      );
    }
  }
  if (opts.rateLimitWindowMs !== void 0 && (!Number.isFinite(opts.rateLimitWindowMs) || !Number.isInteger(opts.rateLimitWindowMs) || opts.rateLimitWindowMs < 1e3)) {
    throw new TypeError(
      `Invalid rateLimitWindowMs: ${opts.rateLimitWindowMs}. Must be an integer >= 1000.`
    );
  }
}
__name(validateRateLimitOptions, "validateRateLimitOptions");
function createLazyBridgeProxy(getBridge, getStartupError = () => void 0) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const bridge = getBridge();
        if (!bridge) {
          const startupError = getStartupError();
          if (startupError) {
            throw new Error(
              `Daemon bridge runtime is not available: ${startupError}`
            );
          }
          throw new Error("Daemon bridge runtime is still starting.");
        }
        const value = Reflect.get(bridge, prop, bridge);
        return typeof value === "function" ? value.bind(bridge) : value;
      }
    }
  );
}
__name(createLazyBridgeProxy, "createLazyBridgeProxy");
function resolveRuntimeStartupTimeoutMs(override) {
  if (override !== void 0) {
    return Number.isFinite(override) && override > 0 ? override : 0;
  }
  const raw = process.env[RUNTIME_STARTUP_TIMEOUT_ENV];
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS;
  }
  const trimmed = raw.trim();
  if (trimmed === "0") return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUNTIME_STARTUP_TIMEOUT_MS;
}
__name(resolveRuntimeStartupTimeoutMs, "resolveRuntimeStartupTimeoutMs");
async function waitForRuntimeStartingForShutdown(runtimeStarting, daemonLog, timeoutMs = SHUTDOWN_FORCE_CLOSE_MS) {
  if (!runtimeStarting) return;
  let timer;
  await Promise.race([
    runtimeStarting,
    new Promise((resolve3) => {
      timer = setTimeout(() => {
        daemonLog.warn(
          `${timeoutMs}ms runtime-startup wait reached during shutdown; continuing listener close`
        );
        resolve3();
      }, timeoutMs);
      timer.unref();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
__name(waitForRuntimeStartingForShutdown, "waitForRuntimeStartingForShutdown");
var BOOTSTRAP_HEALTH_PATH = "/health";
var BOOTSTRAP_CAPABILITIES_PATH = "/capabilities";
var BOOTSTRAP_DAEMON_STATUS_PATH = "/daemon/status";
var BOOTSTRAP_SERVE_PATHS = /* @__PURE__ */ new Set([
  BOOTSTRAP_HEALTH_PATH,
  BOOTSTRAP_CAPABILITIES_PATH,
  BOOTSTRAP_DAEMON_STATUS_PATH
]);
var RUNTIME_STARTUP_FAILED_ENVELOPE = {
  error: "Daemon runtime failed to start",
  code: "daemon_runtime_failed"
};
var RUNTIME_STARTUP_STARTING_ENVELOPE = {
  error: "Daemon runtime is still starting",
  code: "daemon_runtime_starting"
};
function runtimeStartupEnvelope(runtimeError) {
  return runtimeError ? RUNTIME_STARTUP_FAILED_ENVELOPE : RUNTIME_STARTUP_STARTING_ENVELOPE;
}
__name(runtimeStartupEnvelope, "runtimeStartupEnvelope");
function createBootstrapServeApp(input) {
  const {
    opts,
    getPort,
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    workspaceRuntimeAvailable,
    currentSessionSchedulingAvailable,
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime,
    getRuntimeError,
    getChannelWorkerSnapshot,
    getChannelWorkerSnapshots,
    onHealthServed
  } = input;
  const app = (0, import_express.default)();
  const nativeDirectoryPickerAvailable = isNativeDirectoryPickerAvailable();
  const localPathOpenAvailable = isLocalPathOpenAvailable();
  const localTerminalOpenAvailable = isLocalTerminalAvailable();
  installSelfOriginStripMiddleware(app, getPort, opts.hostname);
  app.use(hostAllowlist(opts.hostname, getPort));
  installRemoteSelfOriginMiddleware(app, opts.hostname, opts.token);
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    app.use(allowOriginCors(parseAllowOriginPatterns(opts.allowOrigins)));
  } else {
    app.use(denyBrowserOriginCors);
  }
  const healthHandler = /* @__PURE__ */ __name((req, res) => {
    const runtimeError = getRuntimeError();
    if (runtimeError !== void 0) {
      res.status(503).json({
        status: "degraded",
        error: runtimeError
      });
      return;
    }
    if (onHealthServed) {
      res.once("finish", onHealthServed);
    }
    if (isDeepHealthQuery(req.query["deep"])) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ status: "degraded", reason: "bootstrap" });
      return;
    }
    res.status(200).json({ status: "ok" });
  }, "healthHandler");
  const loopback = isLoopbackBind(opts.hostname);
  const exposeHealthPreAuth = loopback && !opts.requireAuth;
  if (exposeHealthPreAuth) {
    app.get(BOOTSTRAP_HEALTH_PATH, healthHandler);
  }
  app.use(bearerAuth(opts.token));
  if (!exposeHealthPreAuth) {
    app.get(BOOTSTRAP_HEALTH_PATH, healthHandler);
  }
  app.get(BOOTSTRAP_CAPABILITIES_PATH, (_req, res) => {
    if (multiWorkspaceCapabilitiesRequireRuntime) {
      const runtimeError = getRuntimeError();
      if (runtimeError === void 0) {
        res.setHeader("Retry-After", "1");
      }
      res.status(503).json(runtimeStartupEnvelope(runtimeError));
      return;
    }
    res.status(200).json(
      createBootstrapCapabilities({
        opts,
        boundWorkspace,
        qwenCodeVersion,
        sessionShellCommandEnabled,
        sessionArtifactsPersistenceAvailable,
        workspaceRuntimeAvailable,
        currentSessionSchedulingAvailable,
        permissionPolicy,
        env: process.env,
        nativeDirectoryPickerAvailable,
        localPathOpenAvailable,
        localTerminalOpenAvailable
      })
    );
  });
  app.get(BOOTSTRAP_DAEMON_STATUS_PATH, (req, res) => {
    const detail = parseDaemonStatusDetail(req.query["detail"]);
    if (!detail.ok || !detail.detail) {
      res.status(400).json({
        error: "detail must be one of: summary, full",
        code: "invalid_detail"
      });
      return;
    }
    const runtimeError = getRuntimeError();
    const bootstrapJournalGrowthPoolMb = opts.daemonMemoryBudget !== void 0 ? serveJournalGrowthPoolMb({
      budget: opts.daemonMemoryBudget,
      maxJournalEvents: opts.maxJournalEvents,
      maxJournalBytes: opts.maxJournalBytes
    }) : 0;
    const channelWorker = getChannelWorkerSnapshot();
    const channelWorkers = getChannelWorkerSnapshots();
    const runtimeFailed = runtimeError !== void 0;
    const issue = runtimeError ? {
      code: "daemon_runtime_failed",
      severity: "error",
      message: runtimeError
    } : {
      code: "daemon_runtime_starting",
      severity: "warning",
      message: "Daemon runtime is still starting."
    };
    const daemonLogStatus = daemonLog.getStatus();
    const issues = [issue];
    if (daemonLogStatus.health === "degraded") {
      issues.push({
        code: "daemon_log_degraded",
        severity: "warning",
        message: "Daemon file logging is degraded; inspect full status for details."
      });
    }
    const response = {
      v: 1,
      detail: detail.detail,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: runtimeFailed ? "error" : "warning",
      issues,
      daemon: {
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1e3),
        mode: opts.mode,
        workspaceCwd: boundWorkspace,
        startup: {
          ...startup,
          preheat: { ...startup.preheat }
        },
        ...qwenCodeVersion ? { qwenCodeVersion } : {},
        ...daemonLog.getDaemonId() ? { daemonId: daemonLog.getDaemonId() } : {},
        runId: daemonLogStatus.runId,
        logMode: daemonLogStatus.mode,
        logHealth: daemonLogStatus.health,
        ...detail.detail === "full" && daemonLog.getLogPath() ? { logPath: daemonLog.getLogPath() } : {},
        ...detail.detail === "full" ? {
          logIssues: daemonLogStatus.issues,
          logDroppedRecords: daemonLogStatus.droppedRecords,
          logDroppedBytes: daemonLogStatus.droppedBytes
        } : {}
      },
      security: {
        tokenConfigured: Boolean(opts.token),
        requireAuth: opts.requireAuth === true,
        loopbackBind: loopback,
        allowOriginConfigured: opts.allowOrigins !== void 0 && opts.allowOrigins.length > 0,
        allowOriginMode: allowOriginMode(opts.allowOrigins),
        sessionShellCommandEnabled
      },
      limits: {
        maxRegisteredWorkspaces: opts.maxRegisteredWorkspaces,
        maxChannelControlWorkspaces: MAX_CHANNEL_CONTROL_WORKSPACES,
        maxSessions: advertisedMaxSessions(opts.maxSessions),
        maxTotalSessions: positiveFiniteOrNull(opts.maxTotalSessions),
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          opts.maxPendingPromptsPerSession
        ),
        listenerMaxConnections: listenerMaxConnections(opts.maxConnections),
        eventRingSize: opts.eventRingSize ?? DEFAULT_RING_SIZE,
        compactedReplayMaxBytes: opts.compactedReplayMaxBytes ?? DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
        maxJournalEvents: opts.maxJournalEvents ?? DEFAULT_MAX_JOURNAL_EVENTS,
        maxJournalBytes: opts.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES,
        promptDeadlineMs: positiveFiniteOrNull(opts.promptDeadlineMs),
        writerIdleTimeoutMs: positiveFiniteOrNull(opts.writerIdleTimeoutMs),
        channelIdleTimeoutMs: channelIdleTimeoutMs(opts.channelIdleTimeoutMs),
        sessionIdleTimeoutMs: sessionIdleTimeoutMs(opts.sessionIdleTimeoutMs),
        sessionPromptSettledCloseGraceMs: sessionPromptSettledCloseGraceMs(
          opts.sessionPromptSettledCloseGraceMs
        ),
        acpConnectionCap: null,
        acpPreAttachMaxFramesPerStream: null,
        acpPreAttachMaxFramesPerConnection: null,
        acpPreAttachMaxFramesGlobal: null,
        acpPreAttachMaxPayloadBytesPerConnection: null,
        acpPreAttachMaxPayloadBytesGlobal: null,
        // No child-heap policy during bootstrap: it is built with the
        // runtime, so `enforced` is correctly false and `childHeap` null in
        // this window even when the flag says `enforce`.
        memory: toDaemonStatusMemoryLimits(
          opts.daemonMemoryBudget,
          void 0,
          bootstrapJournalGrowthPoolMb > 0 ? {
            poolBytes: bootstrapJournalGrowthPoolMb * 1024 * 1024,
            hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES,
            baselineMaxEvents: opts.maxJournalEvents ?? DEFAULT_MAX_JOURNAL_EVENTS,
            baselineMaxBytes: opts.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES
          } : null
        )
      },
      capabilities: {
        protocolVersions: getServeProtocolVersions(),
        features: currentServeFeaturesForRunQwenServe(
          opts,
          sessionShellCommandEnabled,
          sessionArtifactsPersistenceAvailable,
          workspaceRuntimeAvailable,
          currentSessionSchedulingAvailable,
          process.env,
          nativeDirectoryPickerAvailable,
          localPathOpenAvailable,
          localTerminalOpenAvailable
        )
      },
      runtime: {
        loading: runtimeError === void 0,
        ...runtimeError ? { error: runtimeError } : {},
        sessions: { active: 0 },
        permissions: {
          pending: 0,
          policy: permissionPolicy ?? "first-responder"
        },
        channel: { live: false },
        channelWorker,
        ...channelWorkers.length > 0 ? { channelWorkers } : {},
        transport: {
          restSseActive: 0,
          acp: {
            enabled: false,
            connections: 0,
            connectionStreams: 0,
            sessionStreams: 0,
            sseStreams: 0,
            wsStreams: 0,
            pendingClientRequests: 0,
            preAttach: {
              bufferedConnectionFrames: 0,
              bufferedSessionFrames: 0,
              pendingDeliveryFrames: 0,
              usedFrames: 0,
              usedBytes: 0,
              highWaterFrames: 0,
              highWaterBytes: 0,
              guardFailures: 0
            }
          }
        },
        rateLimit: {
          enabled: opts.rateLimit === true,
          rejectedSinceStart: {
            prompt: 0,
            mutation: 0,
            read: 0
          }
        },
        activity: {
          activePrompts: 0,
          pendingPrompts: 0,
          queuedPrompts: 0,
          lastActivityAt: null,
          idleSinceMs: null
        },
        process: process.memoryUsage()
      },
      ...detail.detail === "full" ? {
        full: {
          sessions: [],
          acpMounts: [],
          acpConnections: [],
          workspace: {},
          auth: {
            supportedDeviceFlowProviders: [],
            pendingDeviceFlowCount: 0
          }
        }
      } : {}
    };
    res.status(200).json(response);
  });
  app.use((_req, res) => {
    res.status(503).json(runtimeStartupEnvelope(getRuntimeError()));
  });
  return app;
}
__name(createBootstrapServeApp, "createBootstrapServeApp");
function createDelegatingServeApp(bootstrapApp, getRuntimeApp, options = {}) {
  const app = (0, import_express.default)();
  app.use((req, res, next) => {
    const dispatch = /* @__PURE__ */ __name(async () => {
      let target = getRuntimeApp();
      if (!target && options.waitForDeferredRuntimeRoutes === true && !isBootstrapServeRoute(req) && !isCorsPreflightRequest(req) && options.startRuntime && options.runtimeReady) {
        const waitStartedAt = performance2.now();
        const timing = {
          startedAt: /* @__PURE__ */ new Date(),
          path: "joined"
        };
        const webhookRequest = isChannelWebhookRequest(req);
        const authGate = webhookRequest ? options.authenticateDeferredChannelWebhookRequest ?? options.authenticateDeferredRuntimeRequest : options.authenticateDeferredRuntimeRequest;
        const preAuthExempted = authGate !== void 0 && await Promise.resolve(options.isPreAuthRequest?.(req)).catch(
          () => false
        ) === true;
        if (authGate && !preAuthExempted) {
          if (!runSynchronousRequestGate(authGate, req, res, next)) {
            return;
          }
        }
        setDeferredRuntimeRequestTiming(req, timing);
        if (options.startRuntime()) {
          timing.path = "started_on_request";
        }
        try {
          await options.runtimeReady;
        } catch {
          if (preAuthExempted) {
            res.status(503).json(RUNTIME_STARTUP_FAILED_ENVELOPE);
            return;
          }
        } finally {
          timing.waitMs = Math.round((performance2.now() - waitStartedAt) * 100) / 100;
        }
        target = getRuntimeApp();
      }
      const handler = target ?? bootstrapApp;
      handler(req, res, next);
    }, "dispatch");
    void dispatch().catch(next);
  });
  return app;
}
__name(createDelegatingServeApp, "createDelegatingServeApp");
function isBootstrapServeRoute(req) {
  const path2 = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
  return BOOTSTRAP_SERVE_PATHS.has(path2);
}
__name(isBootstrapServeRoute, "isBootstrapServeRoute");
function isChannelWebhookRequest(req) {
  return req.method === "POST" && /^\/channels\/[^/]+\/webhooks\/[^/]+\/?$/u.test(req.path);
}
__name(isChannelWebhookRequest, "isChannelWebhookRequest");
function createDeferredChannelWebhookAuth(resolveSource, runtime, daemonLog) {
  return (req, res, next) => {
    const match = /^\/channels\/([^/]+)\/webhooks\/([^/]+)\/?$/u.exec(req.path);
    const channelName = decodeDeferredWebhookPathSegment(match?.[1]);
    const source = decodeDeferredWebhookPathSegment(match?.[2]);
    if (!channelName || !source) {
      daemonLog.warn("deferred webhook auth failed", {
        channelName: channelName ?? "unknown",
        source: source ?? "unknown",
        reason: "invalid webhook path"
      });
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }
    const configSource = resolveSource(channelName);
    const secret = readDeferredWebhookSecret(
      runtime,
      configSource.workspaceCwd,
      channelName,
      source,
      configSource.env
    );
    if (!matchesWebhookSecret(req.get("x-qwen-webhook-secret"), secret)) {
      daemonLog.warn("deferred webhook auth failed", {
        channelName,
        source,
        reason: secret ? "secret mismatch" : "source not configured"
      });
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }
    next();
  };
}
__name(createDeferredChannelWebhookAuth, "createDeferredChannelWebhookAuth");
function decodeDeferredWebhookPathSegment(segment) {
  if (segment === void 0) return void 0;
  try {
    return decodeURIComponent(segment);
  } catch {
    return void 0;
  }
}
__name(decodeDeferredWebhookPathSegment, "decodeDeferredWebhookPathSegment");
function readDeferredWebhookSecret(runtime, workspace, channelName, source, env) {
  try {
    const rawConfig = runtime.loadChannelsConfig(workspace)[channelName];
    if (typeof rawConfig !== "object" || rawConfig === null) {
      return void 0;
    }
    return runtime.parseChannelWebhookConfig(
      channelName,
      rawConfig,
      env
    )?.sources[source]?.secret;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeStderrLine(
      `[webhook-secret] failed to read deferred webhook secret for ${sanitizeLogText(channelName, 128)}/${sanitizeLogText(source, 128)}: ${sanitizeLogText(reason, 512)}`
    );
    return void 0;
  }
}
__name(readDeferredWebhookSecret, "readDeferredWebhookSecret");
function matchesWebhookSecret(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  const expectedDigest = createHash2("sha256").update(expected).digest();
  const candidateDigest = createHash2("sha256").update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}
__name(matchesWebhookSecret, "matchesWebhookSecret");
function isCorsPreflightRequest(req) {
  return req.method === "OPTIONS" && Boolean(req.headers.origin) && Boolean(
    req.headers["access-control-request-method"] || req.headers["access-control-request-headers"]
  );
}
__name(isCorsPreflightRequest, "isCorsPreflightRequest");
function runSynchronousRequestGate(handler, req, res, next) {
  let passed = false;
  handler(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    passed = true;
  });
  return passed;
}
__name(runSynchronousRequestGate, "runSynchronousRequestGate");
function validateAndCanonicalizeWorkspaceInput(rawWorkspace) {
  const workspace = translateAndCheckAbsoluteWorkspacePath(rawWorkspace);
  if (workspace === null) {
    throw new Error(
      `Invalid --workspace "${rawWorkspace}": must be an absolute path.`
    );
  }
  try {
    const stats = fs.statSync(workspace);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid --workspace "${workspace}": exists but is not a directory.`
      );
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = err.code;
      if (code === "ENOENT") {
        throw new Error(
          `Invalid --workspace "${workspace}": directory does not exist.`
        );
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Invalid --workspace "${workspace}": permission denied (${String(code)}). The path exists but cannot be stat'd by the current user.`
        );
      }
    }
    throw err;
  }
  return canonicalizeWorkspace(workspace);
}
__name(validateAndCanonicalizeWorkspaceInput, "validateAndCanonicalizeWorkspaceInput");
async function runQwenServe(optsIn, deps = {}) {
  let daemonLog;
  let owner = "startup";
  let restoreScrubbedLoaderEnv;
  let installedLoaderRejectionReporter;
  try {
    return await runQwenServeImpl(optsIn, deps, {
      initialized: /* @__PURE__ */ __name((logger) => {
        daemonLog = logger;
      }, "initialized"),
      published: /* @__PURE__ */ __name(() => {
        if (owner === "startup") owner = "handle";
      }, "published"),
      signalOwned: /* @__PURE__ */ __name(() => {
        if (owner === "startup") owner = "signal";
      }, "signalOwned"),
      scrubApplied: /* @__PURE__ */ __name((restore) => {
        restoreScrubbedLoaderEnv = restore;
      }, "scrubApplied"),
      reporterInstalled: /* @__PURE__ */ __name((reporter) => {
        installedLoaderRejectionReporter = reporter;
      }, "reporterInstalled")
    });
  } catch (error) {
    if (installedLoaderRejectionReporter) {
      clearLoaderKeyRejectionReporterIfCurrent(
        installedLoaderRejectionReporter
      );
    }
    if (daemonLog && owner === "startup") {
      const startupLog = daemonLog;
      writeDaemonLifecycleBestEffort(
        () => startupLog.error(
          "daemon startup failed",
          error instanceof Error ? error : new Error(String(error))
        )
      );
      await startupLog.close();
    }
    restoreScrubbedLoaderEnv?.();
    throw error;
  }
}
__name(runQwenServe, "runQwenServe");
var brokenPipeGuardInstalled = false;
function installServeBrokenPipeGuard() {
  if (brokenPipeGuardInstalled) return;
  brokenPipeGuardInstalled = true;
  const ignoreEpipe = /* @__PURE__ */ __name((err) => {
    if (err.code !== "EPIPE") throw err;
  }, "ignoreEpipe");
  process.stdout.on("error", ignoreEpipe);
  process.stderr.on("error", ignoreEpipe);
}
__name(installServeBrokenPipeGuard, "installServeBrokenPipeGuard");
async function runQwenServeImpl(optsIn, deps, loggerLifecycle) {
  installServeBrokenPipeGuard();
  const runStartedAt = performance2.now();
  delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  const channelDeliveryAuthorizations = new ChannelDeliveryAuthorizationStore();
  let shouldPreheat = !deps.bridge && shouldPreheatBridge(deps);
  const startup = {
    processStartedAt: new Date(
      Date.now() - Math.round(process.uptime() * 1e3)
    ).toISOString(),
    preheat: {
      status: deps.bridge ? "external_bridge" : shouldPreheat ? "scheduled" : "not_scheduled"
    }
  };
  if (optsIn.memoryProjectScope !== void 0 && !MEMORY_PROJECT_SCOPES.includes(
    optsIn.memoryProjectScope
  )) {
    throw new TypeError(
      `Invalid memoryProjectScope: ${String(optsIn.memoryProjectScope)}. Must be "git-root" or "workspace".`
    );
  }
  preResolveServeFastPathHomeEnvOverrides();
  const baseEnv = { ...process.env };
  const launchMemoryProjectScopeValue = baseEnv["QWEN_CODE_MEMORY_PROJECT_SCOPE"];
  const launchMemoryProjectScope = launchMemoryProjectScopeValue?.trim() ? launchMemoryProjectScopeValue : void 0;
  const memoryProjectScopeValue = optsIn.memoryProjectScope ?? launchMemoryProjectScope ?? "workspace";
  const memoryProjectScopeSource = optsIn.memoryProjectScope !== void 0 ? "option" : launchMemoryProjectScope !== void 0 ? "environment" : "default";
  const resolvedMemoryProjectScope = memoryProjectScopeValue.trim().toLowerCase() === "workspace" ? "workspace" : "git-root";
  baseEnv["QWEN_CODE_MEMORY_PROJECT_SCOPE"] = memoryProjectScopeValue;
  if (process.env["DEV"] !== "true") {
    scrubInheritedLoaderEnv(baseEnv);
  }
  const daemonRuntimeBaseEnv = Object.freeze(baseEnv);
  const loaderEnvScrub = acquireInheritedLoaderEnvScrub(
    process.env,
    "qwen serve",
    "daemon"
  );
  const scrubbedLoaderEnvKeys = loaderEnvScrub.removedKeys;
  const restoreScrubbedLoaderEnv = /* @__PURE__ */ __name(() => {
    loaderEnvScrub.release();
  }, "restoreScrubbedLoaderEnv");
  loggerLifecycle.scrubApplied(restoreScrubbedLoaderEnv);
  if (!optsIn.hostname.trim()) {
    throw new Error(
      "Invalid --hostname: empty value binds every interface. Pass an explicit address (e.g. --hostname 0.0.0.0) or omit the flag."
    );
  }
  const bindHostname = optsIn.hostname.toLowerCase() === "localhost" ? (await (deps.bindHostnameLookup ?? lookup)(optsIn.hostname)).address : optsIn.hostname;
  const { token, generated: generatedToken } = resolveRemoteServeToken(
    optsIn.token,
    isLoopbackBind(optsIn.hostname)
  );
  const trustedLoopbackMode = isTrustedLoopbackMode({
    loopbackBind: isLoopbackAddress(bindHostname),
    tokenConfigured: token !== void 0,
    requireAuth: optsIn.requireAuth === true
  });
  const channelDeliveryDiagnosticRedaction = {
    workerEnv: daemonRuntimeBaseEnv,
    ...token ? { daemonToken: token } : {}
  };
  const sessionShellCommandEnabled = optsIn.enableSessionShell === true && (token !== void 0 || trustedLoopbackMode);
  if (optsIn.enableSessionShell === true && token === void 0 && !trustedLoopbackMode) {
    writeStderrLine(
      `qwen serve: --enable-session-shell ignored because no bearer token is configured. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token to enable direct session shell.`
    );
  }
  const promptDeadlineMs = optsIn.promptDeadlineMs ?? parseDeadlineEnv(
    QWEN_SERVE_PROMPT_DEADLINE_MS_ENV,
    process.env[QWEN_SERVE_PROMPT_DEADLINE_MS_ENV]
  );
  const writerIdleTimeoutMs = optsIn.writerIdleTimeoutMs ?? parseDeadlineEnv(
    QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV,
    process.env[QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS_ENV]
  );
  const clientMcpOverWsEnv = process.env[QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV];
  const cdpTunnelOverWsEnv = process.env[QWEN_SERVE_CDP_TUNNEL_OVER_WS_ENV];
  const chromeExtensionOriginAllowed = hasChromeExtensionOrigin(
    optsIn.allowOrigins
  );
  const rawWorkspaces = resolveWorkspaceInputs(optsIn.workspace);
  const rawWorkspace = rawWorkspaces[0];
  const opts = {
    ...optsIn,
    hostname: bindHostname,
    maxRegisteredWorkspaces: resolveMaxRegisteredWorkspaces(
      optsIn.maxRegisteredWorkspaces,
      daemonRuntimeBaseEnv
    ),
    token,
    promptDeadlineMs,
    writerIdleTimeoutMs,
    workspace: rawWorkspace,
    clientMcpOverWs: optsIn.clientMcpOverWs ?? (!envFlagDisabled(clientMcpOverWsEnv) && clientMcpOverWsEnv !== void 0),
    cdpTunnelOverWs: optsIn.cdpTunnelOverWs ?? (!envFlagDisabled(cdpTunnelOverWsEnv) && (cdpTunnelOverWsEnv !== void 0 || chromeExtensionOriginAllowed))
  };
  let channelRuntime = opts.channelSelection ? await loadChannelWorkerRuntime() : void 0;
  let channelServicePidfile = deps.channelServicePidfile ?? channelRuntime?.channelServicePidfile;
  const ensureChannelRuntime = /* @__PURE__ */ __name(async () => {
    channelRuntime ??= await loadChannelWorkerRuntime();
    channelServicePidfile ??= channelRuntime.channelServicePidfile;
    return channelRuntime;
  }, "ensureChannelRuntime");
  let channelPidfileReserved = false;
  const removeCurrentServePidfile = /* @__PURE__ */ __name(() => {
    if (!channelServicePidfile) return;
    if (!channelPidfileReserved) return;
    if (channelServicePidfile.removeServeServiceInfo) {
      if (channelServicePidfile.removeServeServiceInfo(process.pid)) {
        channelPidfileReserved = false;
      } else {
        const info2 = channelServicePidfile.readServiceInfo();
        if (!info2 || info2.owner !== "serve" || info2.pid !== process.pid || info2.servePid !== process.pid) {
          channelPidfileReserved = false;
        }
      }
      return;
    }
    const info = channelServicePidfile.readServiceInfo();
    if (info?.owner === "serve" && info.pid === process.pid && info.servePid === process.pid) {
      channelServicePidfile.removeServiceInfo();
      const remaining = channelServicePidfile.readServiceInfo();
      channelPidfileReserved = remaining?.owner === "serve" && remaining.pid === process.pid && remaining.servePid === process.pid;
    } else {
      channelPidfileReserved = false;
    }
  }, "removeCurrentServePidfile");
  const reserveChannelServicePidfile = /* @__PURE__ */ __name((selection) => {
    if (!channelServicePidfile) {
      throw new Error("Channel service pidfile runtime is not available.");
    }
    const channelPidfileNames = channelSelectionNames(selection);
    const existingChannelService = channelServicePidfile.readServiceInfo();
    if (existingChannelService) {
      throw channelServicePidfileConflictError(existingChannelService);
    }
    try {
      writeServeChannelReservation(channelServicePidfile, channelPidfileNames);
      channelPidfileReserved = true;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = err.code;
        if (code === "EEXIST") {
          const info = channelServicePidfile.readServiceInfo();
          if (info) {
            throw channelServicePidfileConflictError(info);
          }
          try {
            writeServeChannelReservation(
              channelServicePidfile,
              channelPidfileNames
            );
            channelPidfileReserved = true;
            return;
          } catch (retryErr) {
            if (retryErr && typeof retryErr === "object" && "code" in retryErr && retryErr.code === "EEXIST") {
              throw channelServiceStartingConflictError();
            }
            throw retryErr;
          }
        }
      }
      throw err;
    }
  }, "reserveChannelServicePidfile");
  validateRateLimitOptions(opts);
  if (!opts.hostname.startsWith("[") && opts.hostname.split(":").length === 2) {
    const [host, port] = opts.hostname.split(":");
    throw new Error(
      `Invalid --hostname "${opts.hostname}": looks like a "host:port" combination. Use --port for the port, e.g. "--hostname ${host} --port ${port}".`
    );
  }
  let tlsOptions;
  let tlsCertPath;
  if (opts.tlsCert && !opts.tlsKey || !opts.tlsCert && opts.tlsKey) {
    throw new Error(
      `--tls-cert and --tls-key must be provided together (got only --tls-${opts.tlsCert ? "cert" : "key"}).`
    );
  }
  if (opts.tlsCert && opts.tlsKey) {
    let cert;
    let key;
    try {
      cert = fs.readFileSync(opts.tlsCert);
    } catch (err) {
      throw new Error(
        `Failed to read --tls-cert "${opts.tlsCert}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      key = fs.readFileSync(opts.tlsKey);
    } catch (err) {
      throw new Error(
        `Failed to read --tls-key "${opts.tlsKey}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let x509;
    try {
      x509 = new X509Certificate(cert);
    } catch (err) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" is not a valid certificate: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const now = Date.now();
    if (new Date(x509.validTo).getTime() < now) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" expired on ${x509.validTo}. Renew the certificate and restart.`
      );
    }
    if (new Date(x509.validFrom).getTime() > now) {
      throw new Error(
        `--tls-cert "${opts.tlsCert}" is not yet valid (validFrom: ${x509.validFrom}). Check the certificate's notBefore date or the system clock.`
      );
    }
    tlsOptions = { cert, key };
    tlsCertPath = path.resolve(opts.tlsCert);
  }
  if (!isLoopbackBind(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token (an explicitly empty --token or ${QWEN_SERVER_TOKEN_ENV} counts as none, since a blank source never generates one). Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to loopback (127.0.0.0/8, localhost, ::1, or [::1]).`
    );
  }
  if (opts.requireAuth && !token) {
    throw new Error(
      `Refusing to start with --require-auth set but no bearer token configured. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or omit --require-auth to keep the loopback developer default.`
    );
  }
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    const parsed = parseAllowOriginPatterns(opts.allowOrigins);
    if (parsed.allowAny && !token) {
      throw new Error(
        `Refusing to start with --allow-origin '*' but no bearer token configured. '*' admits any cross-origin browser to the API; without a token, any local page can drive the daemon. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or list specific origins instead of '*'.`
      );
    }
    const nonLoopbackHttpOrigin = findNonLoopbackHttpOrigin(parsed);
    if (nonLoopbackHttpOrigin && !token) {
      throw new Error(
        `Refusing to start with --allow-origin ${JSON.stringify(
          nonLoopbackHttpOrigin
        )} but no bearer token configured. Non-loopback HTTP(S) browser origins can drive the full operator API, including code execution as the daemon user. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or use a loopback origin.`
      );
    }
    writeStderrLine(
      `qwen serve: --allow-origin: ${opts.allowOrigins.join(", ")}` + (parsed.allowAny ? " (WARNING: `*` admits any cross-origin browser \u2014 bearer token gates API routes; the Web Shell static assets stay pre-auth in every mode unless --no-web, and /health stays pre-auth on loopback unless --require-auth is set)" : trustedLoopbackMode ? " (WARNING: these browser origins receive full API authority without a bearer token in trusted loopback mode and can execute code as the daemon user)" : "")
    );
  }
  if (opts.allowPrivateAuthBaseUrl) {
    writeStderrLine(
      "qwen serve: --allow-private-auth-base-url enabled; /workspace/auth/provider may install localhost/private-network model endpoints. Use only for local development with trusted clients."
    );
  }
  const validateAndCanonicalizeWorkspace = validateAndCanonicalizeWorkspaceInput;
  const liveConversationWorkspace = deps.liveConversationWorkspace ?? new ConversationWorkspace();
  const isReservedConversationWorkspace = /* @__PURE__ */ __name((candidate) => {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedRoot = path.resolve(liveConversationWorkspace.rootPath);
    let canonicalRoot = resolvedRoot;
    try {
      canonicalRoot = fs.realpathSync.native(resolvedRoot);
    } catch {
    }
    return resolvedCandidate === resolvedRoot || isWithinRoot(resolvedCandidate, resolvedRoot) || resolvedCandidate === canonicalRoot || isWithinRoot(resolvedCandidate, canonicalRoot);
  }, "isReservedConversationWorkspace");
  const reservedRawWorkspace = rawWorkspaces.find(
    (workspace) => isReservedConversationWorkspace(workspace)
  );
  if (reservedRawWorkspace) {
    throw new Error(
      `Workspace ${JSON.stringify(
        reservedRawWorkspace
      )} is reserved for Conversations.`
    );
  }
  const workspaceInputs = rawWorkspaces.map((workspace) => ({
    raw: workspace,
    cwd: validateAndCanonicalizeWorkspace(workspace),
    displayName: void 0,
    removable: false,
    registrationIds: []
  }));
  const boundWorkspace = workspaceInputs[0].cwd;
  const seenCanonicalWorkspaces = /* @__PURE__ */ new Set();
  for (const workspace of workspaceInputs) {
    if (seenCanonicalWorkspaces.has(workspace.cwd)) {
      throw new Error(
        `Duplicate --workspace value resolves to ${JSON.stringify(
          workspace.cwd
        )}.`
      );
    }
    seenCanonicalWorkspaces.add(workspace.cwd);
  }
  for (let i = 0; i < workspaceInputs.length; i++) {
    for (let j = i + 1; j < workspaceInputs.length; j++) {
      const first = workspaceInputs[i].cwd;
      const second = workspaceInputs[j].cwd;
      const firstRel = path.relative(first, second);
      const secondRel = path.relative(second, first);
      if (firstRel && !firstRel.startsWith("..") && !path.isAbsolute(firstRel)) {
        throw new Error(
          `Nested --workspace values are not supported: ${JSON.stringify(second)} is inside ${JSON.stringify(first)}.`
        );
      }
      if (secondRel && !secondRel.startsWith("..") && !path.isAbsolute(secondRel)) {
        throw new Error(
          `Nested --workspace values are not supported: ${JSON.stringify(first)} is inside ${JSON.stringify(second)}.`
        );
      }
    }
  }
  if (workspaceInputs.length > opts.maxRegisteredWorkspaces) {
    throw new Error(
      `At most ${opts.maxRegisteredWorkspaces} --workspace values may be registered.`
    );
  }
  opts.daemonMemoryBudget = resolveDaemonMemoryBudget({
    budgetMb: opts.memoryBudgetMb
  });
  if (opts.childHeapMode === "admit" && deps.bridge) {
    throw new TypeError(
      "ACP admission cannot be combined with an injected bridge."
    );
  }
  const admissionPolicy = opts.childHeapMode === "admit" ? createChildHeapPolicy({
    budget: opts.daemonMemoryBudget,
    mode: "admit"
  }) : void 0;
  if (opts.daemonMemoryBudget.budgetSource === "flag" || opts.daemonMemoryBudget.insufficientMemory) {
    writeStderrLine(formatMemoryBudgetStderr(opts.daemonMemoryBudget));
  }
  const journalGrowthPoolMbValue = opts.daemonMemoryBudget !== void 0 ? serveJournalGrowthPoolMb({
    budget: opts.daemonMemoryBudget,
    maxJournalEvents: opts.maxJournalEvents,
    maxJournalBytes: opts.maxJournalBytes
  }) : 0;
  const journalGrowthPoolBytes = journalGrowthPoolMbValue > 0 ? journalGrowthPoolMbValue * 1024 * 1024 : void 0;
  const journalGrowthSessionLimitProviders = /* @__PURE__ */ new Set();
  const journalGrowthSessionLimits = /* @__PURE__ */ __name(() => {
    const limits = [];
    for (const provider of journalGrowthSessionLimitProviders) {
      limits.push(...provider());
    }
    return limits;
  }, "journalGrowthSessionLimits");
  const registerJournalGrowthSessionLimits = /* @__PURE__ */ __name((provider) => {
    journalGrowthSessionLimitProviders.add(provider);
    return () => {
      journalGrowthSessionLimitProviders.delete(provider);
    };
  }, "registerJournalGrowthSessionLimits");
  const reservedStartupWorkspace = workspaceInputs.find(
    (workspace) => isReservedConversationWorkspace(workspace.cwd)
  );
  if (reservedStartupWorkspace) {
    throw new Error(
      `Workspace ${JSON.stringify(
        reservedStartupWorkspace.raw
      )} is reserved for Conversations.`
    );
  }
  let workspaceRegistrationStore = deps.workspaceRegistrationStore;
  const explicitWorkspaceCount = workspaceInputs.length;
  if (workspaceRegistrationStore === void 0 && process.env["QWEN_SERVE_NO_PERSISTENT_REGISTRATION"] !== "1") {
    const { WorkspaceRegistrationStore } = await import("./workspace-registration-store-R7IVJE3U.js");
    workspaceRegistrationStore = new WorkspaceRegistrationStore(boundWorkspace);
  }
  if (workspaceRegistrationStore) {
    try {
      const stored = await workspaceRegistrationStore.read();
      for (const storedWorkspace of stored.workspaces) {
        const registrationId = workspaceRegistrationId(storedWorkspace);
        const displayName = stored.displayNames?.[registrationId];
        if (isReservedConversationWorkspace(storedWorkspace)) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace
            )}: path is reserved for Conversations`
          );
          continue;
        }
        let cwd;
        try {
          cwd = validateAndCanonicalizeWorkspace(storedWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace
            )}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        if (isReservedConversationWorkspace(cwd)) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace
            )}: path is reserved for Conversations`
          );
          continue;
        }
        const existingInput = workspaceInputs.find(
          (workspace) => workspace.cwd === cwd
        );
        if (existingInput) {
          existingInput.registrationIds.push(registrationId);
          existingInput.displayName ??= displayName;
          continue;
        }
        const nested = workspaceInputs.some(
          (workspace) => isWithinRoot(cwd, workspace.cwd) || isWithinRoot(workspace.cwd, cwd)
        );
        if (nested) {
          writeStderrLine(
            `qwen serve: skipping persisted workspace registration ${JSON.stringify(
              storedWorkspace
            )}: path nests with an explicit or earlier restored workspace`
          );
          continue;
        }
        workspaceInputs.push({
          raw: storedWorkspace,
          cwd,
          displayName,
          removable: true,
          registrationIds: [registrationId]
        });
      }
    } catch (err) {
      writeStderrLine(
        `qwen serve: failed to read persisted workspace registrations: ${err instanceof Error ? err.message : String(err)}; continuing with explicit workspaces only`
      );
    }
  }
  if (workspaceInputs.length > opts.maxRegisteredWorkspaces) {
    throw new Error(
      `${explicitWorkspaceCount} explicit + ${workspaceInputs.length - explicitWorkspaceCount} restored workspaces exceed the configured limit of ${opts.maxRegisteredWorkspaces}. Restart with the previous capacity, forget registrations and reduce explicit --workspace values before lowering the limit. The registration store was not changed.`
    );
  }
  if (workspaceInputs.length > 1 && deps.bridge) {
    throw new Error(
      "Injected bridge dependencies are only supported with a single workspace; multiple --workspace values require runQwenServe to construct one bridge per workspace."
    );
  }
  let contextFilenameForInit;
  let permissionPolicy;
  let permissionConsensusQuorum;
  let bootSettings;
  let sessionArtifactsPersistenceAvailable = true;
  try {
    bootSettings = deps.bootSettings ?? loadServeFastPathSettings(boundWorkspace);
    sessionArtifactsPersistenceAvailable = sessionArtifactsPersistenceAvailableFromSettings(bootSettings);
    contextFilenameForInit = extractContextFilename(
      bootSettings.context?.fileName
    );
    const policyConfig = bootSettings.policy ?? {};
    const resolved = validatePolicyConfig(policyConfig);
    permissionPolicy = resolved.permissionPolicy;
    permissionConsensusQuorum = resolved.permissionConsensusQuorum;
  } catch (err) {
    if (err instanceof InvalidPolicyConfigError) {
      throw err;
    }
    writeStderrLine(
      `qwen serve: could not read settings for context.fileName / policy.* / serve.channels (${err instanceof Error ? err.message : String(err)}); falling back to defaults. Restart with a valid settings.json to apply context.fileName / policy.* / serve.channels overrides.`
    );
  }
  const daemonLogBaseDir = await resolveDaemonLogBaseDirForRun({
    deps,
    bootSettings,
    boundWorkspace
  });
  const daemonLog = await initDaemonLogger({
    boundWorkspace,
    baseDir: daemonLogBaseDir
  });
  loggerLifecycle.initialized(daemonLog);
  let channelSelectionFromSettings = false;
  const reportConfiguredChannelStartupFailure = /* @__PURE__ */ __name((error) => {
    const message = sanitizeLogText(
      redactLogCredentials(
        error instanceof Error ? error.message : String(error)
      ),
      512
    );
    const detail = /[.!?]$/.test(message) ? message : `${message}.`;
    writeStderrLine(
      `qwen serve: workspace serve.channels was not restored: ${detail} Continuing without channels.`
    );
    daemonLog.warn(
      `workspace serve.channels was not restored: ${detail} Continuing without channels`
    );
  }, "reportConfiguredChannelStartupFailure");
  if (!opts.channelSelection && bootSettings?.serve?.channels !== void 0) {
    try {
      const rawChannels = bootSettings.serve.channels;
      if (!Array.isArray(rawChannels) || !rawChannels.every((name) => typeof name === "string")) {
        throw new Error("serve.channels must be a string array.");
      }
      const configuredChannels = rawChannels.filter((name, index) => {
        if (!name || name !== name.trim() || sanitizeLogText(name, name.length) !== name) {
          daemonLog.warn(
            `ignored invalid workspace serve.channels entry at index ${index}`
          );
          return false;
        }
        return true;
      });
      opts.channelSelection = normalizeServeChannelSelection(
        configuredChannels,
        "serve.channels"
      );
      if (opts.channelSelection) {
        channelSelectionFromSettings = true;
        channelRuntime = await ensureChannelRuntime();
        daemonLog.info("restoring channels from workspace serve.channels", {
          channels: channelSelectionNames(opts.channelSelection),
          workspaceCwd: boundWorkspace
        });
      }
    } catch (error) {
      opts.channelSelection = void 0;
      reportConfiguredChannelStartupFailure(error);
    }
  }
  daemonLog.info("project memory scope resolved", {
    projectMemoryScope: resolvedMemoryProjectScope,
    projectMemoryScopeSource: memoryProjectScopeSource,
    projectMemoryScopeRaw: memoryProjectScopeValue
  });
  const loaderRejectionReporter = /* @__PURE__ */ __name((source, freshKeys) => {
    daemonLog.warn(
      "rejected loader-affecting env keys; they were not applied",
      {
        source,
        rejectedKeys: freshKeys
      }
    );
  }, "loaderRejectionReporter");
  setLoaderKeyRejectionReporter(loaderRejectionReporter);
  loggerLifecycle.reporterInstalled(loaderRejectionReporter);
  if (scrubbedLoaderEnvKeys.length > 0) {
    daemonLog.info(
      "scrubbed inherited loader env vars from the daemon process; session subprocesses will not inherit them",
      { removedKeys: scrubbedLoaderEnvKeys }
    );
  }
  const fastPathRejectedLoaderKeys = consumeServeFastPathRejectedLoaderKeys();
  if (fastPathRejectedLoaderKeys.length > 0) {
    daemonLog.info(
      "rejected loader-affecting env keys during serve fast-path boot; they were not applied to the daemon process",
      { rejectedKeys: fastPathRejectedLoaderKeys }
    );
  }
  let loggerPublished = false;
  let loggerSignalOwned = false;
  writeStderrLine(
    `qwen serve: daemon log \u2192 ${daemonLog.getLogPath() || "(disabled)"}`
  );
  if (opts.mcpClientBudget !== void 0) {
    if (!Number.isFinite(opts.mcpClientBudget) || !Number.isInteger(opts.mcpClientBudget) || opts.mcpClientBudget <= 0) {
      throw new TypeError(
        `Invalid mcpClientBudget: ${opts.mcpClientBudget}. Must be a positive integer.`
      );
    }
  }
  if (opts.mcpBudgetMode === "enforce" && opts.mcpClientBudget === void 0) {
    throw new Error(
      'mcpBudgetMode="enforce" requires a positive mcpClientBudget. Pass mcpClientBudget=N, or set mcpBudgetMode to "warn" or "off".'
    );
  }
  if (opts.promptDeadlineMs !== void 0) {
    if (!isPositiveIntegerMs(opts.promptDeadlineMs)) {
      throw new TypeError(
        `Invalid promptDeadlineMs: ${opts.promptDeadlineMs}. Must be a positive integer (milliseconds).`
      );
    }
    assertTimerDelayInRange("promptDeadlineMs", opts.promptDeadlineMs);
  }
  if (opts.maxSessions !== void 0) {
    if (Number.isNaN(opts.maxSessions) || opts.maxSessions < 0) {
      throw new TypeError(
        `Invalid maxSessions: ${opts.maxSessions}. Must be a number >= 0 (0 / Infinity = unlimited).`
      );
    }
  }
  if (opts.maxTotalSessions !== void 0) {
    if (!isNonNegativeIntegerOrInfinity(opts.maxTotalSessions)) {
      throw new TypeError(
        `Invalid maxTotalSessions: ${opts.maxTotalSessions}. Must be a non-negative integer (0 / Infinity = unlimited).`
      );
    }
  }
  if (opts.maxPendingPromptsPerSession !== void 0) {
    if (!isNonNegativeIntegerOrInfinity(opts.maxPendingPromptsPerSession)) {
      throw new TypeError(
        `Invalid maxPendingPromptsPerSession: ${opts.maxPendingPromptsPerSession}. Must be a non-negative integer (0 / Infinity = unlimited).`
      );
    }
  }
  if (opts.eventRingSize !== void 0) {
    if (!Number.isInteger(opts.eventRingSize) || opts.eventRingSize < 1 || opts.eventRingSize > MAX_EVENT_RING_SIZE) {
      throw new TypeError(
        `Invalid eventRingSize: ${opts.eventRingSize}. Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`
      );
    }
  }
  if (opts.compactedReplayMaxBytes !== void 0) {
    normalizeCompactedReplayMaxBytes(opts.compactedReplayMaxBytes);
  }
  if (opts.maxJournalEvents !== void 0) {
    normalizeMaxJournalEvents(opts.maxJournalEvents);
  }
  if (opts.maxJournalBytes !== void 0) {
    normalizeMaxJournalBytes(opts.maxJournalBytes);
  }
  if (opts.writerIdleTimeoutMs !== void 0) {
    if (!isPositiveIntegerMs(opts.writerIdleTimeoutMs)) {
      throw new TypeError(
        `Invalid writerIdleTimeoutMs: ${opts.writerIdleTimeoutMs}. Must be a positive integer (milliseconds).`
      );
    }
  }
  if (opts.channelIdleTimeoutMs !== void 0) {
    if (!Number.isFinite(opts.channelIdleTimeoutMs) || !Number.isInteger(opts.channelIdleTimeoutMs) || opts.channelIdleTimeoutMs < 0) {
      throw new TypeError(
        `Invalid channelIdleTimeoutMs: ${opts.channelIdleTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = immediate kill).`
      );
    }
  }
  if (opts.sessionReapIntervalMs !== void 0) {
    if (!isNonNegativeIntegerMs(opts.sessionReapIntervalMs)) {
      throw new TypeError(
        `Invalid sessionReapIntervalMs: ${opts.sessionReapIntervalMs}. Must be a non-negative integer (milliseconds, 0 = disabled).`
      );
    }
  }
  if (opts.sessionIdleTimeoutMs !== void 0) {
    if (!isNonNegativeIntegerMs(opts.sessionIdleTimeoutMs)) {
      throw new TypeError(
        `Invalid sessionIdleTimeoutMs: ${opts.sessionIdleTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = disabled).`
      );
    }
  }
  if (opts.sessionPromptSettledCloseGraceMs !== void 0) {
    if (!isNonNegativeIntegerMs(opts.sessionPromptSettledCloseGraceMs)) {
      throw new TypeError(
        `Invalid sessionPromptSettledCloseGraceMs: ${opts.sessionPromptSettledCloseGraceMs}. Must be a non-negative integer (milliseconds, 0 = disabled).`
      );
    }
  }
  if (opts.initializeTimeoutMs !== void 0) {
    if (!isPositiveIntegerMs(opts.initializeTimeoutMs)) {
      throw new TypeError(
        `Invalid initializeTimeoutMs: ${opts.initializeTimeoutMs}. Must be a positive integer (milliseconds).`
      );
    }
    assertTimerDelayInRange("initializeTimeoutMs", opts.initializeTimeoutMs);
  }
  const sessionRestoreTimeoutMs = resolveSessionRestoreTimeoutMs(opts);
  opts.sessionRestoreTimeoutMs = sessionRestoreTimeoutMs;
  if (opts.permissionResponseTimeoutMs !== void 0) {
    if (!Number.isFinite(opts.permissionResponseTimeoutMs) || !Number.isInteger(opts.permissionResponseTimeoutMs) || opts.permissionResponseTimeoutMs < 0) {
      throw new TypeError(
        `Invalid permissionResponseTimeoutMs: ${opts.permissionResponseTimeoutMs}. Must be a non-negative integer (milliseconds, 0 = disabled / wait forever).`
      );
    }
  }
  const rawExternalToolGuard = opts.externalToolGuard;
  if (rawExternalToolGuard !== void 0 && (typeof rawExternalToolGuard !== "object" || rawExternalToolGuard === null || rawExternalToolGuard.mode !== "required")) {
    throw new TypeError(
      "Invalid externalToolGuard: omit it for off mode or set mode to 'required'."
    );
  }
  opts.maxTotalSessions ??= deriveDefaultMaxTotalSessions(
    opts.maxSessions,
    workspaceInputs.length,
    opts.maxRegisteredWorkspaces
  );
  const inheritedNoPool = process.env["QWEN_SERVE_NO_MCP_POOL"] === "1";
  if (opts.mcpPoolActive === void 0 && inheritedNoPool) {
    opts.mcpPoolActive = false;
  }
  let externalToolGuardHandler;
  if (opts.externalToolGuard?.mode === "required") {
    if (deps.bridge) {
      throw new Error(
        "Required external tool guarding cannot be combined with an injected bridge."
      );
    }
    const { RequiredExternalToolGuard } = await import("./external-tool-guard-provider-TE4DRY36.js");
    const provider = new RequiredExternalToolGuard({
      endpoint: opts.externalToolGuard.endpoint,
      token: opts.externalToolGuard.token,
      ...opts.externalToolGuard.timeoutMs !== void 0 ? { timeoutMs: opts.externalToolGuard.timeoutMs } : {}
    });
    await provider.initialize();
    externalToolGuardHandler = provider.prepare;
    writeStderrLine(
      "qwen serve: required external tool guard handshake succeeded."
    );
  }
  const { createDaemonToolGuard } = await import("./daemon-git-worktree-guard-G3YLB3CZ.js");
  const daemonToolGuardHandler = createDaemonToolGuard(
    externalToolGuardHandler
  );
  const childEnvOverrides = {
    QWEN_SERVE_MCP_CLIENT_BUDGET: opts.mcpClientBudget !== void 0 ? String(opts.mcpClientBudget) : void 0,
    QWEN_SERVE_MCP_BUDGET_MODE: opts.mcpBudgetMode,
    QWEN_SERVE_CDP_TUNNEL_OVER_WS: opts.cdpTunnelOverWs ? "1" : void 0,
    // The Conversations marker is enable-only and scoped to the
    // live-conversation bridge below; every other runtime's child must not
    // inherit it from the daemon's own environment.
    [PRIVATE_CONVERSATIONS_RUNTIME_ENV]: void 0,
    [PRIVATE_EXTERNAL_TOOL_GUARD_ENV]: EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
    [PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV]: externalToolGuardHandler ? EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE : void 0
  };
  const cliVersionPromise = getCliVersion();
  let cliVersion;
  const diagnosticSink = /* @__PURE__ */ __name((line, level) => daemonLog.raw(line, level), "diagnosticSink");
  let actualPort = opts.port;
  const webShellDir = opts.serveWebShell === false ? void 0 : resolveWebShellDir();
  if (optsIn.requireWebShell && !webShellDir) {
    throw new Error("--open-with-auth requires built Web Shell assets.");
  }
  if (opts.serveWebShell !== false) {
    if (!webShellDir) {
      writeStderrLine(
        "qwen serve: Web Shell assets not found; serving API only. Build the web-shell workspace (npm run build) or pass --no-web to silence this."
      );
    } else {
      writeStderrLine(`qwen serve: Web Shell UI served from ${webShellDir}`);
      if (!isLoopbackBind(opts.hostname)) {
        writeStderrLine(
          "qwen serve: Web Shell UI is served WITHOUT auth on a non-loopback bind (the static shell has no secrets; the API stays token-gated). Pass --no-web to disable the UI."
        );
        if (!opts.allowOrigins || opts.allowOrigins.length === 0) {
          writeStderrLine(
            "qwen serve: same-origin Web Shell HTTP requests work without --allow-origin, but WebSocket-backed features (terminal, voice) and browsers reaching the daemon through a TLS-terminating proxy still need --allow-origin <origin>. A plain-HTTP intermediary that rewrites the Host header (nginx default proxy_set_header, k8s Ingress) needs --allow-origin <origin> for the origin the browser sees, unless it forwards Host verbatim; port translation alone (ssh -L, docker -p) is fine."
          );
        }
      }
    }
  }
  const webShellMounted = !!webShellDir;
  const serveAppLifecycle = new ServeAppLifecycleController();
  const liveDiscoveryStableBaseDir = path.resolve(
    deps.liveDiscoveryStableBaseDir ?? path.join(os.homedir(), ".qwen")
  );
  let resolveServeAppStartup;
  let rejectServeAppStartup;
  let serveAppStartupSettled = false;
  const serveAppStartupReady = new Promise((resolve3, reject) => {
    resolveServeAppStartup = resolve3;
    rejectServeAppStartup = reject;
  });
  void serveAppStartupReady.catch(() => void 0);
  const markServeAppStartupReady = /* @__PURE__ */ __name(() => {
    if (serveAppStartupSettled) return;
    serveAppStartupSettled = true;
    resolveServeAppStartup();
  }, "markServeAppStartupReady");
  const markServeAppStartupFailed = /* @__PURE__ */ __name((error) => {
    if (serveAppStartupSettled) return;
    serveAppStartupSettled = true;
    rejectServeAppStartup(error);
  }, "markServeAppStartupFailed");
  let runtimeApp;
  let runtimeAppForCleanup;
  let getWorkspaceRuntimeCoordinatorIfSupported;
  let bridgeRef = deps.bridge;
  let managedProcessRegistry;
  let managedChildHeapPolicy;
  const internalRuntimeBridgesForCleanup = [];
  let daemonEventLoopMonitor;
  let daemonMetricsSampler;
  let sessionPrRefreshTimer;
  let sessionPrRefreshGeneration = 0;
  let runtimeStartupError;
  let runtimeStarting;
  let markRuntimeReady;
  let markRuntimeFailed;
  let runtimeStartupSettled = false;
  let startRuntimeAfterHealth;
  let startRuntimeForRequest;
  const deferRuntimeUntilFirstHealth = deps.resolveOnListen === true && deps.deferRuntimeUntilFirstHealth === true;
  const runtimeReady = new Promise((resolve3, reject) => {
    markRuntimeReady = resolve3;
    markRuntimeFailed = reject;
  });
  void runtimeReady.catch(() => {
  });
  const disposeDaemonEventLoopMonitor = /* @__PURE__ */ __name(() => {
    const eventLoopMonitor = daemonEventLoopMonitor;
    daemonEventLoopMonitor = void 0;
    const metricsSampler = daemonMetricsSampler;
    daemonMetricsSampler = void 0;
    const prRefreshTimer = sessionPrRefreshTimer;
    sessionPrRefreshTimer = void 0;
    sessionPrRefreshGeneration += 1;
    prRefreshTimer?.dispose();
    try {
      eventLoopMonitor?.dispose();
    } catch (err) {
      daemonLog.warn(
        `event loop monitor dispose error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      metricsSampler?.dispose();
    } catch (err) {
      daemonLog.warn(
        `metrics sampler dispose error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, "disposeDaemonEventLoopMonitor");
  let channelWorkerManager;
  let channelWorkerManagerStarting;
  let channelControlDraining = false;
  let channelWorkspaceGroups;
  const channelWebhookEnvByWorkspace = /* @__PURE__ */ new Map();
  let channelWebhookConfigVersion = 0;
  let refreshChannelWebhookConfigs;
  let ensureChannelWorkerManager;
  const getChannelWebhookConfigSources = /* @__PURE__ */ __name(() => {
    const app2 = runtimeApp ?? runtimeAppForCleanup;
    const registry = app2?.locals?.["workspaceRegistry"];
    return (channelWorkspaceGroups ?? []).map((group) => {
      const env = registry?.getByWorkspaceCwd(group.workspaceCwd)?.env.effectiveEnv ?? channelWebhookEnvByWorkspace.get(group.workspaceCwd);
      return {
        workspaceCwd: group.workspaceCwd,
        ...group.selection.mode === "names" ? { channelNames: group.selection.names } : {},
        ...env ? { env } : {}
      };
    });
  }, "getChannelWebhookConfigSources");
  const resolveChannelWebhookConfigSource = /* @__PURE__ */ __name((channelName) => {
    const source = getChannelWebhookConfigSources().find(
      (source2) => !source2.channelNames || source2.channelNames.includes(channelName)
    );
    if (source) return source;
    const env = channelWebhookEnvByWorkspace.get(boundWorkspace);
    return {
      workspaceCwd: boundWorkspace,
      ...env ? { env } : {}
    };
  }, "resolveChannelWebhookConfigSource");
  let closeServerAfterChannelWorkerStartupFailure = false;
  const getChannelWorkerSnapshot = /* @__PURE__ */ __name(() => channelWorkerManager?.primarySnapshot() ?? {
    enabled: false,
    state: "disabled",
    channels: []
  }, "getChannelWorkerSnapshot");
  const getChannelWorkerSnapshots = /* @__PURE__ */ __name(() => channelWorkerManager?.snapshots() ?? [], "getChannelWorkerSnapshots");
  const getChannelWorkerControl = /* @__PURE__ */ __name(() => channelWorkerManager?.state() ?? {
    enabled: false,
    selection: null,
    transition: "idle",
    workers: []
  }, "getChannelWorkerControl");
  const daemonDrainingError = /* @__PURE__ */ __name(() => Object.assign(new Error("Daemon is shutting down."), {
    code: "daemon_draining"
  }), "daemonDrainingError");
  const setChannelWorkerSelection = /* @__PURE__ */ __name(async (selection) => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager = await ensureChannelWorkerManager?.();
    if (!manager) throw new Error("Channel worker manager is unavailable.");
    if (channelControlDraining) {
      await manager.shutdown().catch(() => void 0);
      throw daemonDrainingError();
    }
    return manager.setSelection(selection);
  }, "setChannelWorkerSelection");
  const stopChannelWorker = /* @__PURE__ */ __name(async () => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager = channelWorkerManager ?? await channelWorkerManagerStarting;
    if (channelControlDraining) {
      await manager?.shutdown().catch(() => void 0);
      throw daemonDrainingError();
    }
    if (!manager) {
      return { changed: false, state: getChannelWorkerControl() };
    }
    return manager.stopSelection();
  }, "stopChannelWorker");
  const reloadChannelWorker = /* @__PURE__ */ __name(async () => {
    if (channelControlDraining) throw daemonDrainingError();
    const manager = channelWorkerManager ?? await channelWorkerManagerStarting;
    if (channelControlDraining) {
      await manager?.shutdown().catch(() => void 0);
      throw daemonDrainingError();
    }
    if (!manager) {
      return { enabled: false, state: "disabled", channels: [] };
    }
    try {
      return await manager.reload();
    } finally {
      writeChannelWorkerPidfile();
    }
  }, "reloadChannelWorker");
  const isLiveWorker = /* @__PURE__ */ __name((snapshot) => snapshot.state === "running" || snapshot.state === "starting", "isLiveWorker");
  let channelWorkerPidfileUsesWorkers = workspaceInputs.length > 1;
  const writeChannelWorkerPidfile = /* @__PURE__ */ __name(() => {
    if (runtimeStartupError !== void 0) return;
    if (!channelPidfileReserved || !channelServicePidfile) return;
    const snapshots = getChannelWorkerSnapshots();
    const workers = snapshots.map((snapshot) => ({
      workspaceId: snapshot.workspaceId,
      workspaceCwd: snapshot.workspaceCwd,
      channels: snapshot.channels,
      // Drop a stale pid (worker exited/failed/stopped) so readers never signal
      // a dead process — mirrors the pre-4b clear-on-exit behavior.
      ...isLiveWorker(snapshot) && snapshot.pid !== void 0 ? { workerPid: snapshot.pid } : {}
    }));
    const channels = [
      ...new Set(snapshots.flatMap((snapshot) => snapshot.channels))
    ];
    const primary = snapshots.find((snapshot) => snapshot.primary);
    if (workers.length > 1 || snapshots.some((snapshot) => !snapshot.primary)) {
      channelWorkerPidfileUsesWorkers = true;
    }
    const includeWorkers = channelWorkerPidfileUsesWorkers && workers.length > 0;
    try {
      channelServicePidfile.writeServeServiceInfo({
        channels,
        servePid: process.pid,
        ...primary && isLiveWorker(primary) && primary.pid !== void 0 ? { workerPid: primary.pid } : {},
        ...includeWorkers ? { workers } : {}
      });
    } catch (err) {
      daemonLog.warn(
        `failed to write channel worker pidfile metadata: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, "writeChannelWorkerPidfile");
  const handleBridge = deps.bridge ?? createLazyBridgeProxy(
    () => bridgeRef,
    () => runtimeStartupError
  );
  const shutdownBridges = /* @__PURE__ */ new WeakSet();
  const disposedRuntimeApps = /* @__PURE__ */ new WeakSet();
  const stoppedRuntimeAppProducers = /* @__PURE__ */ new WeakSet();
  const stoppedExtensionReconcilers = /* @__PURE__ */ new WeakSet();
  const stoppedTrustPolicyMonitors = /* @__PURE__ */ new WeakSet();
  const stopTrustPolicyMonitor = /* @__PURE__ */ __name((app2) => {
    if (!app2 || stoppedTrustPolicyMonitors.has(app2)) return;
    stoppedTrustPolicyMonitors.add(app2);
    const stop = app2.locals?.["stopTrustPolicyMonitor"];
    try {
      stop?.();
    } catch (err) {
      daemonLog.warn(
        `trust policy monitor dispose error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, "stopTrustPolicyMonitor");
  const stopExtensionReconciler = /* @__PURE__ */ __name((app2) => {
    if (!app2 || stoppedExtensionReconcilers.has(app2)) return;
    stoppedExtensionReconcilers.add(app2);
    const stopExtensionGenerationReconciler = app2.locals?.["stopExtensionGenerationReconciler"];
    try {
      stopExtensionGenerationReconciler?.();
    } catch (err) {
      daemonLog.warn(
        `extension generation reconciler dispose error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, "stopExtensionReconciler");
  const stopRuntimeAppProducers = /* @__PURE__ */ __name((app2) => {
    if (!app2 || stoppedRuntimeAppProducers.has(app2)) return;
    stoppedRuntimeAppProducers.add(app2);
    const locals = app2.locals;
    const stopSafely = /* @__PURE__ */ __name((name, stop) => {
      try {
        stop?.();
      } catch (err) {
        daemonLog.warn(
          `${name} dispose error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, "stopSafely");
    stopSafely("scheduled-task keepalive", locals.stopScheduledTaskKeepalive);
    stopSafely("workspace git state", locals.stopWorkspaceGitState);
    stopSafely("Live Host coordinator", locals.stopLiveCoordinator);
    stopSafely("web terminal registry", locals.stopWebTerminalRegistry);
    stopTrustPolicyMonitor(app2);
    for (const stop of locals.subSessionStoppers ?? []) {
      stopSafely("sub-session launcher", stop);
    }
    stopExtensionReconciler(app2);
  }, "stopRuntimeAppProducers");
  const disposeRuntimeAppResources = /* @__PURE__ */ __name((app2) => {
    if (!app2 || disposedRuntimeApps.has(app2)) return;
    disposedRuntimeApps.add(app2);
    stopRuntimeAppProducers(app2);
    const deviceFlowRegistry = getDeviceFlowRegistry(app2);
    if (deviceFlowRegistry) {
      try {
        deviceFlowRegistry.dispose();
      } catch (err) {
        daemonLog.warn(
          `device-flow registry dispose error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const localControlService = app2.locals?.["localControlService"];
    if (localControlService) {
      void localControlService.dispose().catch((err) => {
        daemonLog.warn(
          `Local Control dispose error: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    const acpHandle = app2.locals?.["acpHandle"];
    if (acpHandle?.dispose) {
      try {
        acpHandle.dispose();
      } catch (err) {
        daemonLog.warn(
          `ACP handle dispose error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const rateLimiter = getRateLimiter(app2);
    if (rateLimiter) {
      try {
        rateLimiter.setDraining(true);
        rateLimiter.dispose();
      } catch (err) {
        daemonLog.warn(
          `rate limiter dispose error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    disposeDaemonEventLoopMonitor();
  }, "disposeRuntimeAppResources");
  const getRuntimeBridgesForCleanup = /* @__PURE__ */ __name(() => {
    const appForCleanup = runtimeApp ?? runtimeAppForCleanup;
    const registry = appForCleanup?.locals?.["workspaceRegistry"];
    const bridges = [
      ...registry ? registry.listManaged().map((runtime) => runtime.bridge) : [],
      ...bridgeRef ? [bridgeRef] : [],
      ...internalRuntimeBridgesForCleanup
    ];
    return [...new Set(bridges)];
  }, "getRuntimeBridgesForCleanup");
  const buildRuntime = /* @__PURE__ */ __name(async () => {
    const [runtime, core, settingsRuntime, resolvedCliVersion, trustPolicy] = await Promise.all([
      loadServeRuntimeModules(),
      loadCoreRuntime(),
      loadSettingsRuntimeModules(),
      cliVersionPromise,
      import("./daemon-trust-policy-IL7XNHXQ.js")
    ]);
    getWorkspaceRuntimeCoordinatorIfSupported = runtime.getWorkspaceRuntimeCoordinatorIfSupported;
    cliVersion = resolvedCliVersion;
    settingsRuntime.environment.preResolveHomeEnvOverrides();
    const bootTrustSnapshot = await trustPolicy.readDaemonTrustPolicySnapshot();
    let latestTrustPolicySnapshot = bootTrustSnapshot;
    const bootPrimaryTrustDecision = trustPolicy.evaluateDaemonWorkspaceTrust(
      bootTrustSnapshot,
      boundWorkspace
    );
    const trustedWorkspace = deps.trustedWorkspace ?? bootPrimaryTrustDecision.targetTrusted;
    if (shouldPreheat && !trustedWorkspace) {
      shouldPreheat = false;
      startup.preheat.status = "not_scheduled";
    }
    const workspaceTrustHotReloadAvailable = deps.trustedWorkspace === void 0 && deps.bridge === void 0 && deps.fsFactory === void 0;
    let managedScratchRoot;
    try {
      managedScratchRoot = prepareManagedScratchRoot(
        path.join(core.Storage.getGlobalQwenDir(), "scratch-workspaces"),
        workspaceInputs.map((workspace) => workspace.cwd)
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: managed scratch workspaces are unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let runtimeBootSettings;
    try {
      runtimeBootSettings = settingsRuntime.settings.loadSettings(
        boundWorkspace,
        {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trustedWorkspace,
          workspaceTrusted: trustedWorkspace
        }
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: could not read full settings for runtime startup (${err instanceof Error ? err.message : String(err)}); falling back to defaults.`
      );
    }
    if (deps.trustedWorkspace === void 0 && runtimeBootSettings && !trustedWorkspace) {
      daemonLog.warn(
        "workspace file writes are disabled because the bound workspace is not trusted",
        { workspace: boundWorkspace }
      );
    }
    const runtimeEnvSnapshot = runtimeBootSettings ? settingsRuntime.environment.buildRuntimeEnvironment(
      runtimeBootSettings.merged,
      boundWorkspace,
      daemonRuntimeBaseEnv,
      trustedWorkspace
    ) : {
      effectiveEnv: { ...daemonRuntimeBaseEnv },
      overlayKeys: Object.freeze([]),
      envFilePaths: Object.freeze([]),
      envFileReadFailed: false,
      envFileReadFailures: Object.freeze([])
    };
    const resolveSessionRuntimeBaseDir = /* @__PURE__ */ __name((workspace, settings, effectiveEnv) => {
      const resolveConfiguredPath = /* @__PURE__ */ __name((configuredPath, relativeTo) => {
        const expanded = configuredPath === "~" ? os.homedir() : configuredPath.startsWith("~/") || configuredPath.startsWith("~\\") ? path.join(
          os.homedir(),
          ...configuredPath.slice(2).split(/[/\\]+/).filter(Boolean)
        ) : configuredPath;
        return path.resolve(relativeTo, expanded);
      }, "resolveConfiguredPath");
      const runtimeDir = effectiveEnv["QWEN_RUNTIME_DIR"];
      if (runtimeDir) {
        return resolveConfiguredPath(runtimeDir, process.cwd());
      }
      const settingsDir = settings?.merged.advanced?.runtimeOutputDir;
      if (settingsDir) {
        return resolveConfiguredPath(settingsDir, workspace);
      }
      const qwenHome = effectiveEnv["QWEN_HOME"];
      if (qwenHome) {
        return resolveConfiguredPath(qwenHome, process.cwd());
      }
      const homeDir = os.homedir();
      return homeDir ? path.join(homeDir, ".qwen") : path.join(os.tmpdir(), ".qwen");
    }, "resolveSessionRuntimeBaseDir");
    const logRuntimeEnvFileReadFailures = /* @__PURE__ */ __name((workspace, snapshot) => {
      if (!snapshot.envFileReadFailed) return;
      const failedFiles = snapshot.envFileReadFailures ?? [];
      daemonLog.warn("one or more runtime env files could not be read", {
        workspace,
        ...failedFiles.length > 0 ? { failedFiles } : {}
      });
    }, "logRuntimeEnvFileReadFailures");
    logRuntimeEnvFileReadFailures(boundWorkspace, runtimeEnvSnapshot);
    const primarySessionRuntimeBaseDir = resolveSessionRuntimeBaseDir(
      boundWorkspace,
      runtimeBootSettings,
      runtimeEnvSnapshot.effectiveEnv
    );
    const runtimeEffectiveEnv = {
      ...runtimeEnvSnapshot.effectiveEnv,
      QWEN_RUNTIME_DIR: primarySessionRuntimeBaseDir
    };
    const replaceRuntimeEffectiveEnv = /* @__PURE__ */ __name((nextEnv) => {
      for (const key of Object.keys(runtimeEffectiveEnv)) {
        delete runtimeEffectiveEnv[key];
      }
      Object.assign(runtimeEffectiveEnv, nextEnv);
      runtimeEffectiveEnv["QWEN_RUNTIME_DIR"] = primarySessionRuntimeBaseDir;
    }, "replaceRuntimeEffectiveEnv");
    const primaryRuntimeEnv = {
      mode: "runtime-overlay",
      overlayKeys: [...runtimeEnvSnapshot.overlayKeys],
      effectiveEnv: runtimeEffectiveEnv,
      workflowsEnabledBySettings: runtimeBootSettings?.merged.tools?.workflowsEnabled === true,
      envFilePaths: [...runtimeEnvSnapshot.envFilePaths],
      envFileReadFailed: runtimeEnvSnapshot.envFileReadFailed,
      envFileReadFailures: [...runtimeEnvSnapshot.envFileReadFailures]
    };
    const daemonWorkspaceHash = core.hashDaemonWorkspace(boundWorkspace);
    let daemonTelemetrySettings;
    try {
      daemonTelemetrySettings = await core.resolveTelemetrySettings({
        env: process.env,
        settings: runtimeBootSettings?.merged.telemetry
      });
    } catch (err) {
      if (err instanceof core.FatalConfigError) {
        throw new core.FatalConfigError(
          `Invalid telemetry configuration: ${err.message}.`
        );
      }
      throw err;
    }
    await core.initializeTelemetry(
      createDaemonTelemetryRuntimeConfig(
        daemonTelemetrySettings,
        resolvedCliVersion,
        `daemon:${process.pid}`,
        {
          otlpEndpoint: core.DEFAULT_OTLP_ENDPOINT,
          telemetryTarget: core.DEFAULT_TELEMETRY_TARGET
        }
      )
    );
    core.initializeDaemonMetrics();
    daemonEventLoopMonitor?.dispose();
    daemonEventLoopMonitor = core.startEventLoopLagMonitor({
      onNewMaxStall: /* @__PURE__ */ __name((maxMs) => {
        daemonLog.warn("daemon event loop stall detected", { maxMs });
      }, "onNewMaxStall")
    });
    const currentDaemonEventLoopMonitor = daemonEventLoopMonitor;
    core.registerDaemonEventLoopLagGauge(
      () => currentDaemonEventLoopMonitor.snapshot()
    );
    const metricsRing = new DaemonMetricsRing({
      capacity: DAEMON_METRICS_CAPACITY
    });
    const pipeStats = {
      inbound: { count: 0, totalBytes: 0, maxBytes: 0 },
      outbound: { count: 0, totalBytes: 0, maxBytes: 0 }
    };
    const promptQueueWaitStats = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: null
    };
    const recordPipeMessage = /* @__PURE__ */ __name((direction, bytes) => {
      const stats = pipeStats[direction];
      stats.count += 1;
      stats.totalBytes += bytes;
      stats.maxBytes = Math.max(stats.maxBytes, bytes);
      core.recordDaemonPipeMessage(direction, bytes);
      metricsRing.recordPipe(direction, bytes);
    }, "recordPipeMessage");
    const observeLargePipeFrame = createLargePipeFrameObserver({
      daemonLog,
      emitTelemetryLog: core.emitDaemonLog
    });
    const warnAcpQueueSaturated = /* @__PURE__ */ __name((info) => {
      daemonLog.warn("ACP NDJSON decoded queue saturated", {
        requiredBytes: info.requiredBytes,
        availableBytes: info.availableBytes,
        maxQueuedMessages: info.maxQueuedMessages,
        maxQueuedBytes: info.maxQueuedBytes,
        queueSaturationGraceMs: info.graceMs
      });
    }, "warnAcpQueueSaturated");
    const recordPromptQueueWait = /* @__PURE__ */ __name((durationMs) => {
      promptQueueWaitStats.count += 1;
      promptQueueWaitStats.totalMs += durationMs;
      promptQueueWaitStats.maxMs = Math.max(
        promptQueueWaitStats.maxMs,
        durationMs
      );
      promptQueueWaitStats.lastMs = durationMs;
      core.recordDaemonPromptQueueWait(durationMs);
    }, "recordPromptQueueWait");
    const createRuntimeBridgeTelemetry = /* @__PURE__ */ __name((workspaceHash) => {
      const telemetry = core.createDaemonBridgeTelemetry();
      telemetry.metrics = {
        sessionLifecycle(action) {
          core.recordDaemonSessionLifecycle(action);
          core.emitDaemonLog(
            `Session ${action}.`,
            {
              "qwen-code.workspace.hash": workspaceHash
            },
            {
              eventName: `qwen-code.daemon.session.${action}`
            }
          );
        },
        channelLifecycle(action, expected) {
          core.recordDaemonChannelLifecycle(action, expected);
          core.emitDaemonLog(
            action === "spawn" ? "ACP channel spawned." : `ACP channel exited (expected=${expected ?? true}).`,
            {
              ...action === "exit" ? { "qwen-code.daemon.channel.expected": expected ?? true } : {}
            },
            {
              eventName: `qwen-code.daemon.channel.${action}`,
              ...expected === false && action === "exit" ? { severityNumber: 13 } : {}
            }
          );
        },
        promptQueueWait(durationMs) {
          recordPromptQueueWait(durationMs);
          metricsRing.recordPromptQueueWait(durationMs);
        },
        promptDuration(durationMs) {
          core.recordDaemonPromptDuration(durationMs);
          metricsRing.recordPromptDuration(durationMs);
        },
        cancelled: core.recordDaemonCancel,
        // Per-round model token usage + LLM round-trip time sniffed off
        // `agent_message_chunk._meta` (`usage` + `durationMs`) at the bridge's
        // single session/update fan-in. Increments (not cumulative), so the ring
        // sums tokens per window (token-burn chart) and pools the round-trip times
        // for the LLM-latency percentiles. `apiErrors` / `apiRetries` ride the
        // same frame (per-round increments, 0 when none) and window into the
        // model-API-health chart.
        tokenUsage(inputTokens, outputTokens, durationMs, apiErrors, apiRetries) {
          metricsRing.recordTokens(inputTokens, outputTokens);
          if (typeof durationMs === "number") {
            metricsRing.recordLlmDuration(durationMs);
          }
          metricsRing.recordApiActivity(apiErrors ?? 0, apiRetries ?? 0);
        }
      };
      return telemetry;
    }, "createRuntimeBridgeTelemetry");
    const daemonTelemetry = createRuntimeBridgeTelemetry(daemonWorkspaceHash);
    const permissionAuditRing = new PermissionAuditRing();
    const permissionAuditPublisher = createPermissionAuditPublisher({
      ring: permissionAuditRing
    });
    const customIgnoreFiles = runtimeBootSettings?.merged.context?.fileFiltering?.customIgnoreFiles;
    const boundWorkspaces = runtime.resolveBoundWorkspacesFromIdeEnv(
      boundWorkspace,
      void 0,
      (workspace, index) => {
        if (index === 0) return true;
        const trustedSecondary = trustPolicy.evaluateDaemonWorkspaceTrust(
          bootTrustSnapshot,
          workspace
        ).targetTrusted;
        if (!trustedSecondary) {
          daemonLog.warn(
            "excluding untrusted secondary workspace root from file-system access",
            { workspace }
          );
        }
        return trustedSecondary;
      }
    );
    daemonLog.info("daemon workspace roots initialized", {
      primary: boundWorkspaces[0],
      secondary: boundWorkspaces.slice(1),
      ideEnvPresent: !!process.env["QWEN_CODE_IDE_WORKSPACE_PATH"]
    });
    const primaryGenerationGuard = runtime.createWorkspaceGenerationGuard();
    const primaryTrustMaterialization = JSON.stringify({
      trusted: trustedWorkspace,
      boundWorkspaces: [...boundWorkspaces].sort()
    });
    const sharedPathLocks = new PathMutexRegistry();
    const workspaceTrustOperationGate = new PathMutexRegistry();
    const runWorkspaceTrustOperation = /* @__PURE__ */ __name((operation) => workspaceTrustOperationGate.runExclusive("runtime-topology", operation), "runWorkspaceTrustOperation");
    const idleReclaimerRef = {};
    const processRegistry = new runtime.ProcessRegistry();
    managedProcessRegistry = processRegistry;
    const childHeapPolicy = opts.daemonMemoryBudget && !deps.bridge ? admissionPolicy ?? createChildHeapPolicy({
      budget: opts.daemonMemoryBudget,
      mode: opts.childHeapMode ?? "observe"
    }) : void 0;
    managedChildHeapPolicy = childHeapPolicy;
    const fsFactory = runtime.resolveBridgeFsFactory({
      // Secondary roots share a write-capable factory only after their own
      // folder trust check passes; untrusted secondary roots stay outside.
      boundWorkspaces,
      injected: deps.fsFactory,
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      generationGuard: primaryGenerationGuard,
      ...customIgnoreFiles !== void 0 ? { customIgnoreFiles } : {}
    });
    const routeFsFactory = runtime.resolveBridgeFsFactory({
      // REST routes still return primary-relative paths, so keep their
      // filesystem boundary primary-only until responses carry root IDs.
      boundWorkspaces: [boundWorkspace],
      trusted: trustedWorkspace,
      emit: deps.fsAuditEmit,
      pathLocks: sharedPathLocks,
      generationGuard: primaryGenerationGuard,
      ...customIgnoreFiles !== void 0 ? { customIgnoreFiles } : {}
    });
    const channelFactory = runtime.createSpawnChannelFactory({
      processRegistry,
      childHeapPolicy,
      reclaimIdleChild: /* @__PURE__ */ __name(async (signal) => {
        await idleReclaimerRef.current?.(daemonWorkspaceHash, signal);
      }, "reclaimIdleChild"),
      pipeLimits: runtime.daemonAcpNdJsonLimits,
      sourceEnv: runtimeEffectiveEnv,
      onDiagnosticLine: diagnosticSink,
      pipeHooks: {
        onMessageSent: /* @__PURE__ */ __name((bytes) => recordPipeMessage("outbound", bytes), "onMessageSent"),
        onMessageReceived: /* @__PURE__ */ __name((bytes) => recordPipeMessage("inbound", bytes), "onMessageReceived"),
        onMessageObserved: /* @__PURE__ */ __name(({ direction, bytes, message }) => observeLargePipeFrame({
          direction: daemonPipeDirection(direction),
          bytes,
          message
        }), "onMessageObserved"),
        onQueueSaturated: warnAcpQueueSaturated
      },
      ...acpChildExtraArgs(opts) ? { extraArgs: acpChildExtraArgs(opts) } : {}
    });
    const statusProvider = runtime.createDaemonStatusProvider({
      env: runtimeEffectiveEnv
    });
    const workspaceProvidersStatusProvider = runtime.createWorkspaceProvidersStatusProvider({
      env: runtimeEffectiveEnv,
      workspaceTrusted: trustedWorkspace
    });
    const workspaceSkillsStatusProvider = runtime.createWorkspaceSkillsStatusProvider({
      workspaceTrusted: trustedWorkspace
    });
    const clientMcpSenderRegistry = new ClientMcpSenderRegistry();
    const runtimeBridges = [];
    const runtimeEpochSources = /* @__PURE__ */ new Map();
    const runtimeEpochSourceFor = /* @__PURE__ */ __name((workspaceCwd) => {
      let source = runtimeEpochSources.get(workspaceCwd);
      if (!source) {
        let epoch = 0;
        source = {
          current: /* @__PURE__ */ __name(() => epoch, "current"),
          allocate: /* @__PURE__ */ __name(() => ++epoch, "allocate")
        };
        runtimeEpochSources.set(workspaceCwd, source);
      }
      return source;
    }, "runtimeEpochSourceFor");
    let mcpAuthenticationActive = false;
    const acquireMcpAuthentication = /* @__PURE__ */ __name(() => {
      if (mcpAuthenticationActive) return void 0;
      mcpAuthenticationActive = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        mcpAuthenticationActive = false;
      };
    }, "acquireMcpAuthentication");
    const totalSessionAdmission = runtime.createTotalSessionAdmissionController(
      {
        maxTotalSessions: opts.maxTotalSessions,
        getBridges: /* @__PURE__ */ __name(() => runtimeBridges.length > 0 ? runtimeBridges : bridgeRef ? [bridgeRef] : [], "getBridges")
      }
    );
    const sessionOwnerIndex = runtime.createWorkspaceSessionOwnerIndex();
    const workspaceRegistryForPersistence = { current: void 0 };
    const isWorkspaceTrustedForPersistence = /* @__PURE__ */ __name((workspace) => workspaceRegistryForPersistence.current?.getByWorkspaceCwd(workspace)?.trusted ?? (workspaceRegistryForPersistence.current === void 0 && workspace === boundWorkspace && trustedWorkspace), "isWorkspaceTrustedForPersistence");
    const loadSettingsForPersistence = /* @__PURE__ */ __name((workspace) => {
      const trusted = isWorkspaceTrustedForPersistence(workspace);
      return settingsRuntime.settings.loadSettings(workspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: !trusted,
        workspaceTrusted: trusted
      });
    }, "loadSettingsForPersistence");
    const resolveSkillToggleIdentities = /* @__PURE__ */ __name(async (workspace, skillNames) => {
      let skills;
      try {
        const workspaceRuntime = workspaceRegistryForPersistence.current?.getByWorkspaceCwd(workspace);
        const status = await workspaceRuntime?.workspaceService.getWorkspaceSkillsStatus({
          route: "skill settings persistence",
          workspaceCwd: workspace
        });
        if (status?.initialized) skills = status.skills;
      } catch {
      }
      const skillsByName = new Map(
        skills?.map((skill) => [skill.name.trim().toLowerCase(), skill])
      );
      return skillNames.map((skillName) => {
        const skill = skillsByName.get(skillName.trim().toLowerCase());
        if (!skill) {
          const prefixEnd = skillName.indexOf(":");
          return {
            name: skillName,
            ...prefixEnd > 0 ? { authoredName: skillName.slice(prefixEnd + 1) } : {}
          };
        }
        if (skill.level !== "extension" || !skill.extensionName) {
          return { name: skillName };
        }
        return {
          name: skillName,
          authoredName: skillName.slice(skill.extensionName.length + 1)
        };
      });
    }, "resolveSkillToggleIdentities");
    const persistDisabledToolsFn = /* @__PURE__ */ __name((workspace, toolName, enabled, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const fresh = loadSettingsForPersistence(workspace);
      const wsScope = fresh.forScope(WORKSPACE_SETTING_SCOPE).settings;
      const wsDisabled = wsScope.tools?.disabled;
      const current = Array.isArray(wsDisabled) ? wsDisabled.filter((v) => typeof v === "string") : [];
      const next = new Set(current);
      if (enabled) next.delete(toolName);
      else next.add(toolName);
      assertGenerationOpen?.();
      fresh.setValue(
        WORKSPACE_SETTING_SCOPE,
        "tools.disabled",
        [...next].sort(),
        assertGenerationOpen
      );
    }), "persistDisabledToolsFn");
    const persistDisabledSkillsFn = /* @__PURE__ */ __name((workspace, skillName, enabled, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const {
        skillSettingStrings,
        skillToggleBlockForName,
        updateWorkspaceSkillSettingLists
      } = await import("./skill-settings-N2YFXNX4.js");
      const fresh = loadSettingsForPersistence(workspace);
      const workspaceDisabled = skillSettingStrings(
        fresh,
        WORKSPACE_SETTING_SCOPE,
        "disabled"
      );
      const workspaceEnabled = skillSettingStrings(
        fresh,
        WORKSPACE_SETTING_SCOPE,
        "enabled"
      );
      if (enabled) {
        const [skillIdentity] = await resolveSkillToggleIdentities(
          workspace,
          [skillName]
        );
        const block = skillToggleBlockForName(fresh, skillIdentity);
        if (block) {
          return { changed: false, disabled: workspaceDisabled, block };
        }
      }
      const next = updateWorkspaceSkillSettingLists(
        { disabled: workspaceDisabled, enabled: workspaceEnabled },
        skillName,
        enabled
      );
      const settingsChanges = [];
      if (JSON.stringify(next.disabled) !== JSON.stringify(workspaceDisabled)) {
        settingsChanges.push({
          key: "skills.disabled",
          value: next.disabled.length > 0 ? next.disabled : void 0
        });
      }
      if (JSON.stringify(next.enabled) !== JSON.stringify(workspaceEnabled)) {
        settingsChanges.push({
          key: "skills.enabled",
          value: next.enabled.length > 0 ? next.enabled : void 0
        });
      }
      if (settingsChanges.length === 0) {
        return { changed: false, disabled: workspaceDisabled };
      }
      assertGenerationOpen?.();
      fresh.setValues(
        settingsChanges.map((change) => ({
          scope: WORKSPACE_SETTING_SCOPE,
          ...change
        })),
        void 0,
        assertGenerationOpen
      );
      return {
        changed: true,
        disabled: next.disabled,
        settingsChanges
      };
    }), "persistDisabledSkillsFn");
    const persistDisabledSkillsBatchFn = /* @__PURE__ */ __name((workspace, skillNames, enabled, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const {
        skillSettingStrings,
        skillToggleBlockForName,
        updateWorkspaceSkillSettingLists
      } = await import("./skill-settings-N2YFXNX4.js");
      const fresh = loadSettingsForPersistence(workspace);
      const initialDisabled = skillSettingStrings(
        fresh,
        WORKSPACE_SETTING_SCOPE,
        "disabled"
      );
      const initialEnabled = skillSettingStrings(
        fresh,
        WORKSPACE_SETTING_SCOPE,
        "enabled"
      );
      const skillIdentities = enabled ? await resolveSkillToggleIdentities(workspace, skillNames) : skillNames.map((name) => ({ name }));
      let next = { disabled: initialDisabled, enabled: initialEnabled };
      const outcomes = skillNames.map((skillName) => ({ skillName, changed: false }));
      let pending = skillNames.map((_, index) => index);
      for (let pass = 0; pass < skillNames.length; pass += 1) {
        const refused = [];
        let listChanged = false;
        for (const index of pending) {
          const skillName = skillNames[index];
          if (enabled) {
            const block = skillToggleBlockForName(
              fresh,
              skillIdentities[index]
            );
            if (block && !(block.scope === "Workspace" && block.list === "disabled" && !next.disabled.some(
              (name) => name.trim().toLowerCase() === block.entry
            ))) {
              refused.push(index);
              continue;
            }
          }
          const updated = updateWorkspaceSkillSettingLists(
            next,
            skillName,
            enabled
          );
          const changed = JSON.stringify(updated.disabled) !== JSON.stringify(next.disabled) || JSON.stringify(updated.enabled) !== JSON.stringify(next.enabled);
          next = updated;
          outcomes[index] = { skillName, changed };
          listChanged ||= changed;
        }
        pending = refused;
        if (pending.length === 0 || !listChanged) break;
      }
      const settingsChanges = [];
      if (JSON.stringify(next.disabled) !== JSON.stringify(initialDisabled)) {
        settingsChanges.push({
          key: "skills.disabled",
          value: next.disabled.length > 0 ? next.disabled : void 0
        });
      }
      if (JSON.stringify(next.enabled) !== JSON.stringify(initialEnabled)) {
        settingsChanges.push({
          key: "skills.enabled",
          value: next.enabled.length > 0 ? next.enabled : void 0
        });
      }
      if (settingsChanges.length > 0) {
        assertGenerationOpen?.();
        fresh.setValues(
          settingsChanges.map((change) => ({
            scope: WORKSPACE_SETTING_SCOPE,
            ...change
          })),
          void 0,
          assertGenerationOpen
        );
      }
      return { outcomes, settingsChanges };
    }), "persistDisabledSkillsBatchFn");
    const persistSettingFn = /* @__PURE__ */ __name((workspace, scope, key, value, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const fresh = loadSettingsForPersistence(workspace);
      assertGenerationOpen?.();
      fresh.setValue(scope, key, value, assertGenerationOpen);
      return fresh;
    }), "persistSettingFn");
    const persistSettingsFn = /* @__PURE__ */ __name((workspace, writes, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const fresh = loadSettingsForPersistence(workspace);
      const writesByScope = /* @__PURE__ */ new Map();
      for (const write of writes) {
        writesByScope.set(
          write.scope,
          (writesByScope.get(write.scope) ?? 0) + 1
        );
      }
      const committedScopes = /* @__PURE__ */ new Set();
      let committed = 0;
      try {
        assertGenerationOpen?.();
        fresh.setValues(
          writes,
          (scope) => {
            committedScopes.add(scope);
            committed += writesByScope.get(scope) ?? 0;
          },
          assertGenerationOpen
        );
      } catch (err) {
        const failedWrite = writes.find((write) => !committedScopes.has(write.scope)) ?? writes[committed];
        const message = `persistSettings partial failure (workspace=${workspace}, committed=${committed}/${writes.length}, failedKey=${failedWrite?.key ?? "<unknown>"}, failedScope=${failedWrite?.scope ?? "<unknown>"}): ${err instanceof Error ? err.message : String(err)}`;
        writeStderrLine(`qwen serve: ${message}`);
        throw new runtime.WorkspaceSettingsPartialPersistError(
          message,
          writes.filter((write) => committedScopes.has(write.scope)),
          err
        );
      }
    }), "persistSettingsFn");
    const [{ createSubSessionLauncher }, scheduledTaskRoutes] = await Promise.all([
      import("./create-sub-session-2JVOHDPT.js"),
      import("./scheduled-tasks-P4EULTAX.js")
    ]);
    const { sessionAttachmentsRoots } = await import("./session-attachments-root-FKRRQZNB.js");
    const createCurrentSessionScheduledTaskHandler = /* @__PURE__ */ __name((workspaceCwd, runtimeBaseDir, getBridge, assertGenerationOpen) => async ({
      callerSessionId,
      cron,
      prompt,
      recurring,
      assertCallerPromptActive
    }) => {
      const targetBridge = getBridge();
      if (!targetBridge) {
        throw new Error(
          "Current-session scheduling is unavailable while the workspace runtime is starting."
        );
      }
      const task = await scheduledTaskRoutes.createScheduledTaskWithExistingSession(
        {
          workspaceCwd,
          runtimeBaseDir,
          bridge: targetBridge,
          assertGenerationOpen,
          resolveLiveSessionOwner: /* @__PURE__ */ __name((sessionId) => workspaceRegistryForPersistence.current === void 0 ? { kind: "unavailable" } : workspaceRegistryForPersistence.current.resolveLiveSessionOwner(
            sessionId
          ), "resolveLiveSessionOwner")
        },
        {
          sessionId: callerSessionId,
          cron,
          prompt,
          recurring
        },
        { source: "cron-tool", assertCallerPromptActive }
      );
      return { id: task.id, cron: task.cron };
    }, "createCurrentSessionScheduledTaskHandler");
    const subSessionLauncher = createSubSessionLauncher({
      getBridge: /* @__PURE__ */ __name(() => bridgeRef, "getBridge"),
      boundWorkspace,
      runtimeBaseDir: primarySessionRuntimeBaseDir,
      ...subSessionConcurrencyCapsFromSettings(
        runtimeBootSettings?.merged.serve ?? {}
      )
    });
    const attachmentsRoots = sessionAttachmentsRoots(
      boundWorkspace,
      primarySessionRuntimeBaseDir
    );
    const bridge = deps.bridge ?? runtime.createAcpSessionBridge({
      artifactSnapshotRuntimeBaseDir: primarySessionRuntimeBaseDir,
      sessionAttachmentsRoot: attachmentsRoots.root,
      sessionAttachmentsFallbackRoot: attachmentsRoots.fallback,
      // Reverse tool channel: let `BridgeClient.extMethod` reach the WS
      // connection that hosts a named client MCP server (#5626).
      clientMcpSender: clientMcpSenderRegistry.lookup,
      onCreateSubSession: subSessionLauncher.launch,
      onCreateCurrentSessionScheduledTask: createCurrentSessionScheduledTaskHandler(
        boundWorkspace,
        primarySessionRuntimeBaseDir,
        () => bridgeRef,
        () => primaryGenerationGuard.assertOpen()
      ),
      onChannelDelivery: createBoundChannelDeliveryHandler(
        boundWorkspace,
        () => channelWorkerManager,
        channelDeliveryAuthorizations,
        daemonLog,
        channelDeliveryDiagnosticRedaction
      ),
      maxSessions: opts.maxSessions,
      ...opts.restoreAskUserQuestion === true ? { restoreAskUserQuestion: true } : {},
      freshSessionAdmission: totalSessionAdmission.admit,
      sessionLifecycle: /* @__PURE__ */ __name((event) => {
        if (event.type === "registered" && primaryGenerationGuard.closed) {
          return;
        }
        sessionOwnerIndex.handleBridgeSessionLifecycle(event);
      }, "sessionLifecycle"),
      ...opts.maxPendingPromptsPerSession !== void 0 ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession } : {},
      ...opts.eventRingSize !== void 0 ? { eventRingSize: opts.eventRingSize } : {},
      ...opts.compactedReplayMaxBytes !== void 0 ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes } : {},
      ...opts.maxJournalEvents !== void 0 ? { maxJournalEvents: opts.maxJournalEvents } : {},
      ...opts.maxJournalBytes !== void 0 ? { maxJournalBytes: opts.maxJournalBytes } : {},
      ...journalGrowthPoolBytes !== void 0 ? {
        journalGrowthPoolBytes,
        journalGrowthSessionLimits,
        registerJournalGrowthSessionLimits
      } : {},
      ...opts.channelIdleTimeoutMs !== void 0 ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs } : {},
      ...opts.initializeTimeoutMs !== void 0 ? { initializeTimeoutMs: opts.initializeTimeoutMs } : {},
      sessionRestoreTimeoutMs,
      ...opts.sessionReapIntervalMs !== void 0 ? { sessionReapIntervalMs: opts.sessionReapIntervalMs } : {},
      ...opts.sessionIdleTimeoutMs !== void 0 ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs } : {},
      ...opts.sessionPromptSettledCloseGraceMs !== void 0 ? {
        sessionPromptSettledCloseGraceMs: opts.sessionPromptSettledCloseGraceMs
      } : {},
      ...opts.permissionResponseTimeoutMs !== void 0 ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs } : {},
      boundWorkspace,
      runtimeEpochSource: runtimeEpochSourceFor(boundWorkspace),
      acquireMcpAuthentication,
      // Prompt terminal ledger: persisted beside the transcript so a
      // restarted daemon can reconcile dangling prompts on cold load.
      promptLedger: runtime.createPromptLedgerSink(
        boundWorkspace,
        primarySessionRuntimeBaseDir
      ),
      sessionShellCommandEnabled,
      childEnvOverrides,
      channelFactory,
      externalToolGuard: daemonToolGuardHandler,
      onDiagnosticLine: diagnosticSink,
      telemetry: daemonTelemetry,
      ...permissionPolicy !== void 0 ? { permissionPolicy } : {},
      ...permissionConsensusQuorum !== void 0 ? { permissionConsensusQuorum } : {},
      permissionAudit: permissionAuditPublisher,
      statusProvider,
      delegateReadTextFileToClient: false,
      fileSystem: createBridgeFileSystemAdapter(fsFactory, {
        allowSameHostToolWritesOutsideWorkspace: deps.fsFactory === void 0
      }),
      persistApprovalMode: /* @__PURE__ */ __name((workspace, mode) => withSettingsLock(workspace, async () => {
        primaryGenerationGuard.assertOpen();
        if (!trustedWorkspace) {
          throw new Error(
            "Cannot persist approval mode for an untrusted workspace."
          );
        }
        const fresh = settingsRuntime.settings.loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: trustedWorkspace
        });
        primaryGenerationGuard.assertOpen();
        fresh.setValue(
          WORKSPACE_SETTING_SCOPE,
          "tools.approvalMode",
          mode,
          () => primaryGenerationGuard.assertOpen()
        );
      }), "persistApprovalMode")
    });
    if (!deps.bridge) {
      bridgeRef = bridge;
      internalRuntimeBridgesForCleanup.push(bridge);
    }
    runtimeBridges.push(bridge);
    let invalidatePrimaryServeFeaturesCache = /* @__PURE__ */ __name(() => {
    }, "invalidatePrimaryServeFeaturesCache");
    const reloadPrimaryDaemonEnv = /* @__PURE__ */ __name((workspace, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const fresh = settingsRuntime.settings.loadSettings(workspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: !trustedWorkspace,
        workspaceTrusted: trustedWorkspace
      });
      assertGenerationOpen?.();
      let refreshedRuntimeEnv;
      try {
        refreshedRuntimeEnv = settingsRuntime.environment.buildRuntimeEnvironment(
          fresh.merged,
          workspace,
          daemonRuntimeBaseEnv,
          trustedWorkspace
        );
      } catch (err) {
        const fallbackReason = err instanceof Error ? err.message : String(err);
        primaryRuntimeEnv.fallbackReason = fallbackReason;
        daemonLog.warn(
          "failed to rebuild runtime env snapshot before daemon env reload; preserving previous runtime env",
          {
            error: fallbackReason
          }
        );
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
      logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
      if (refreshedRuntimeEnv.envFileReadFailed) {
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
      const result = settingsRuntime.settings.reloadEnvironment(
        fresh.merged,
        workspace,
        trustedWorkspace,
        { failClosedOnEnvFileReadError: true }
      );
      if (result.envFileReadFailed) {
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
      replaceRuntimeEffectiveEnv(refreshedRuntimeEnv.effectiveEnv);
      primaryRuntimeEnv.workflowsEnabledBySettings = fresh.merged.tools?.workflowsEnabled === true;
      delete primaryRuntimeEnv.fallbackReason;
      primaryRuntimeEnv.envFileReadFailed = refreshedRuntimeEnv.envFileReadFailed;
      primaryRuntimeEnv.envFileReadFailures.splice(
        0,
        primaryRuntimeEnv.envFileReadFailures.length,
        ...refreshedRuntimeEnv.envFileReadFailures
      );
      primaryRuntimeEnv.overlayKeys.splice(
        0,
        primaryRuntimeEnv.overlayKeys.length,
        ...refreshedRuntimeEnv.overlayKeys
      );
      primaryRuntimeEnv.envFilePaths.splice(
        0,
        primaryRuntimeEnv.envFilePaths.length,
        ...refreshedRuntimeEnv.envFilePaths
      );
      return {
        ...result,
        runtimeEnvironmentApplied: true
      };
    }), "reloadPrimaryDaemonEnv");
    const workspaceService = runtime.createDaemonWorkspaceService({
      boundWorkspace,
      isWorkspaceTrusted: /* @__PURE__ */ __name(() => trustedWorkspace, "isWorkspaceTrusted"),
      assertGenerationOpen: /* @__PURE__ */ __name(() => primaryGenerationGuard.assertOpen(), "assertGenerationOpen"),
      contextFilename: contextFilenameForInit ?? "QWEN.md",
      statusProvider,
      workspaceProvidersStatusProvider,
      workspaceSkillsStatusProvider,
      skillInstallEnv: runtimeEffectiveEnv,
      voiceEnv: runtimeEffectiveEnv,
      isChannelLive: /* @__PURE__ */ __name(() => bridge.isChannelLive(), "isChannelLive"),
      persistDisabledTools: persistDisabledToolsFn,
      persistDisabledSkills: persistDisabledSkillsFn,
      persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      preheatAcpChild: /* @__PURE__ */ __name(() => bridge.preheat(), "preheatAcpChild"),
      reloadDaemonEnv: reloadPrimaryDaemonEnv,
      queryWorkspaceStatus: /* @__PURE__ */ __name((method, idle) => bridge.queryWorkspaceStatus(method, idle), "queryWorkspaceStatus"),
      invokeWorkspaceCommand: /* @__PURE__ */ __name((method, params, invokeOpts) => bridge.invokeWorkspaceCommand(method, params, invokeOpts), "invokeWorkspaceCommand"),
      refreshExtensionsForAllSessions: /* @__PURE__ */ __name(() => bridge.refreshExtensionsForAllSessions(), "refreshExtensionsForAllSessions"),
      publishWorkspaceEvent: /* @__PURE__ */ __name((event) => {
        if (event.type === "settings_changed" || event.type === "settings_reloaded") {
          invalidatePrimaryServeFeaturesCache();
        }
        bridge.publishWorkspaceEvent(event);
      }, "publishWorkspaceEvent")
    });
    const workspaceRuntimes = [
      {
        workspaceId: daemonWorkspaceHash,
        workspaceCwd: boundWorkspace,
        sessionRuntimeBaseDir: primarySessionRuntimeBaseDir,
        ...workspaceInputs[0]?.displayName ? { displayName: workspaceInputs[0].displayName } : {},
        primary: true,
        trusted: trustedWorkspace,
        removable: false,
        registrationIds: workspaceInputs[0]?.registrationIds ?? [],
        env: primaryRuntimeEnv,
        bridge,
        workspaceService,
        routeFileSystemFactory: routeFsFactory,
        clientMcpSenderRegistry,
        generationGuard: primaryGenerationGuard,
        trustMaterialization: primaryTrustMaterialization
      }
    ];
    const createRuntimeEnvMetadata = /* @__PURE__ */ __name((workspace, settings, trusted) => {
      const snapshot = settings ? settingsRuntime.environment.buildRuntimeEnvironment(
        settings.merged,
        workspace,
        daemonRuntimeBaseEnv,
        trusted
      ) : {
        effectiveEnv: { ...daemonRuntimeBaseEnv },
        overlayKeys: Object.freeze([]),
        envFilePaths: Object.freeze([]),
        envFileReadFailed: false,
        envFileReadFailures: Object.freeze([])
      };
      logRuntimeEnvFileReadFailures(workspace, snapshot);
      const sessionRuntimeBaseDir = resolveSessionRuntimeBaseDir(
        workspace,
        settings,
        snapshot.effectiveEnv
      );
      const effectiveEnv = {
        ...snapshot.effectiveEnv,
        QWEN_RUNTIME_DIR: sessionRuntimeBaseDir
      };
      const metadata = {
        mode: "runtime-overlay",
        overlayKeys: [...snapshot.overlayKeys],
        effectiveEnv,
        workflowsEnabledBySettings: settings?.merged.tools?.workflowsEnabled === true,
        envFilePaths: [...snapshot.envFilePaths],
        envFileReadFailed: snapshot.envFileReadFailed,
        envFileReadFailures: [...snapshot.envFileReadFailures]
      };
      return {
        metadata,
        effectiveEnv,
        sessionRuntimeBaseDir,
        replace(nextEnv) {
          for (const key of Object.keys(effectiveEnv)) {
            delete effectiveEnv[key];
          }
          Object.assign(effectiveEnv, nextEnv);
          effectiveEnv["QWEN_RUNTIME_DIR"] = sessionRuntimeBaseDir;
        }
      };
    }, "createRuntimeEnvMetadata");
    const reloadRuntimeOverlaySnapshotForModelProviders = /* @__PURE__ */ __name((workspace, trusted, env, assertGenerationOpen) => withSettingsLock(workspace, async () => {
      assertGenerationOpen?.();
      const fresh = settingsRuntime.settings.loadSettings(workspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: !trusted,
        workspaceTrusted: trusted
      });
      assertGenerationOpen?.();
      let refreshedRuntimeEnv;
      try {
        refreshedRuntimeEnv = settingsRuntime.environment.buildRuntimeEnvironment(
          fresh.merged,
          workspace,
          daemonRuntimeBaseEnv,
          trusted
        );
      } catch (err) {
        env.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
        daemonLog.warn(
          "failed to rebuild runtime overlay for model-provider reload; preserving previous runtime env",
          { workspace, error: env.metadata.fallbackReason }
        );
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
      logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
      if (refreshedRuntimeEnv.envFileReadFailed) {
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
      assertGenerationOpen?.();
      try {
        env.replace(refreshedRuntimeEnv.effectiveEnv);
        env.metadata.envFileReadFailed = refreshedRuntimeEnv.envFileReadFailed;
        env.metadata.envFileReadFailures.splice(
          0,
          env.metadata.envFileReadFailures.length,
          ...refreshedRuntimeEnv.envFileReadFailures
        );
        env.metadata.overlayKeys.splice(
          0,
          env.metadata.overlayKeys.length,
          ...refreshedRuntimeEnv.overlayKeys
        );
        env.metadata.envFilePaths.splice(
          0,
          env.metadata.envFilePaths.length,
          ...refreshedRuntimeEnv.envFilePaths
        );
        delete env.metadata.fallbackReason;
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: true
        };
      } catch (err) {
        env.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
        daemonLog.warn(
          "failed to apply runtime overlay for model-provider reload; preserving previous runtime env",
          { workspace, error: env.metadata.fallbackReason }
        );
        return {
          updatedKeys: [],
          removedKeys: [],
          runtimeEnvironmentApplied: false
        };
      }
    }), "reloadRuntimeOverlaySnapshotForModelProviders");
    const readLiveConversationScheduledTasks = /* @__PURE__ */ __name(async () => {
      if (!fs.existsSync(liveConversationWorkspace.rootPath)) return [];
      const { canonicalRoot } = await liveConversationWorkspace.revalidate();
      let settings;
      try {
        settings = settingsRuntime.settings.loadSettings(canonicalRoot, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: false,
          workspaceTrusted: true
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for Conversations (${err instanceof Error ? err.message : String(err)}); falling back to defaults.`
        );
      }
      const env = createRuntimeEnvMetadata(canonicalRoot, settings, true);
      return core.Storage.runWithResolvedRuntimeBaseDir(
        env.sessionRuntimeBaseDir,
        () => core.readCronTasks(canonicalRoot)
      );
    }, "readLiveConversationScheduledTasks");
    const subSessionStoppers = [];
    const subSessionStoppersByRuntime = /* @__PURE__ */ new WeakMap();
    const runtimeCleanupPromises = /* @__PURE__ */ new WeakMap();
    const removeArrayValue = /* @__PURE__ */ __name((values, value) => {
      const index = values.indexOf(value);
      if (index >= 0) values.splice(index, 1);
    }, "removeArrayValue");
    for (const workspaceInput of workspaceInputs.slice(1)) {
      const secondaryDecision = trustPolicy.evaluateDaemonWorkspaceTrust(
        bootTrustSnapshot,
        workspaceInput.cwd
      );
      const secondaryTrusted = secondaryDecision.targetTrusted;
      let secondarySettings;
      try {
        secondarySettings = settingsRuntime.settings.loadSettings(
          workspaceInput.cwd,
          {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: !secondaryTrusted,
            workspaceTrusted: secondaryTrusted
          }
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for secondary workspace ${workspaceInput.cwd} (${err instanceof Error ? err.message : String(err)}); falling back to defaults.`
        );
      }
      if (!secondaryTrusted) {
        daemonLog.warn("secondary workspace is not trusted", {
          workspace: workspaceInput.cwd,
          trustSettingsAvailable: secondarySettings !== void 0
        });
      }
      const secondaryEnv = createRuntimeEnvMetadata(
        workspaceInput.cwd,
        secondarySettings,
        secondaryTrusted
      );
      const secondaryCustomIgnoreFiles = secondarySettings?.merged.context?.fileFiltering?.customIgnoreFiles;
      const secondaryContextFilename = extractContextFilename(secondarySettings?.merged.context?.fileName) ?? contextFilenameForInit ?? "QWEN.md";
      const secondaryWorkspaceHash = core.hashDaemonWorkspace(
        workspaceInput.cwd
      );
      const secondaryGenerationGuard = runtime.createWorkspaceGenerationGuard();
      const secondaryStatusProvider = runtime.createDaemonStatusProvider({
        env: secondaryEnv.effectiveEnv
      });
      const secondaryBridgeFsFactory = runtime.resolveBridgeFsFactory({
        boundWorkspaces: [workspaceInput.cwd],
        trusted: secondaryTrusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        generationGuard: secondaryGenerationGuard,
        ...secondaryCustomIgnoreFiles !== void 0 ? { customIgnoreFiles: secondaryCustomIgnoreFiles } : {}
      });
      const secondaryChannelFactory = runtime.createSpawnChannelFactory({
        processRegistry,
        childHeapPolicy,
        reclaimIdleChild: /* @__PURE__ */ __name(async (signal) => {
          await idleReclaimerRef.current?.(secondaryWorkspaceHash, signal);
        }, "reclaimIdleChild"),
        pipeLimits: runtime.daemonAcpNdJsonLimits,
        sourceEnv: secondaryEnv.effectiveEnv,
        onDiagnosticLine: diagnosticSink,
        pipeHooks: {
          onMessageSent: /* @__PURE__ */ __name((bytes) => recordPipeMessage("outbound", bytes), "onMessageSent"),
          onMessageReceived: /* @__PURE__ */ __name((bytes) => recordPipeMessage("inbound", bytes), "onMessageReceived"),
          onMessageObserved: /* @__PURE__ */ __name(({ direction, bytes, message }) => observeLargePipeFrame({
            direction: daemonPipeDirection(direction),
            bytes,
            message
          }), "onMessageObserved"),
          onQueueSaturated: warnAcpQueueSaturated
        },
        ...acpChildExtraArgs(opts) ? { extraArgs: acpChildExtraArgs(opts) } : {}
      });
      const secondaryClientMcpSenderRegistry = new ClientMcpSenderRegistry();
      let secondaryBridgeRef;
      const secondarySubSessionLauncher = createSubSessionLauncher({
        getBridge: /* @__PURE__ */ __name(() => secondaryBridgeRef, "getBridge"),
        boundWorkspace: workspaceInput.cwd,
        runtimeBaseDir: secondaryEnv.sessionRuntimeBaseDir,
        ...subSessionConcurrencyCapsFromSettings(
          secondarySettings?.merged.serve ?? {}
        )
      });
      const secondaryAttachmentsRoots = sessionAttachmentsRoots(
        workspaceInput.cwd,
        secondaryEnv.sessionRuntimeBaseDir
      );
      const secondaryBridge = runtime.createAcpSessionBridge({
        artifactSnapshotRuntimeBaseDir: secondaryEnv.sessionRuntimeBaseDir,
        sessionAttachmentsRoot: secondaryAttachmentsRoots.root,
        sessionAttachmentsFallbackRoot: secondaryAttachmentsRoots.fallback,
        clientMcpSender: secondaryClientMcpSenderRegistry.lookup,
        onCreateSubSession: secondarySubSessionLauncher.launch,
        onCreateCurrentSessionScheduledTask: createCurrentSessionScheduledTaskHandler(
          workspaceInput.cwd,
          secondaryEnv.sessionRuntimeBaseDir,
          () => secondaryBridgeRef,
          () => secondaryGenerationGuard.assertOpen()
        ),
        onChannelDelivery: createBoundChannelDeliveryHandler(
          workspaceInput.cwd,
          () => channelWorkerManager,
          channelDeliveryAuthorizations,
          daemonLog,
          channelDeliveryDiagnosticRedaction
        ),
        maxSessions: opts.maxSessions,
        ...opts.restoreAskUserQuestion === true ? { restoreAskUserQuestion: true } : {},
        freshSessionAdmission: totalSessionAdmission.admit,
        sessionLifecycle: /* @__PURE__ */ __name((event) => {
          if (event.type === "registered" && secondaryGenerationGuard.closed) {
            return;
          }
          sessionOwnerIndex.handleBridgeSessionLifecycle(event);
        }, "sessionLifecycle"),
        ...opts.maxPendingPromptsPerSession !== void 0 ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession } : {},
        ...opts.eventRingSize !== void 0 ? { eventRingSize: opts.eventRingSize } : {},
        ...opts.compactedReplayMaxBytes !== void 0 ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes } : {},
        ...opts.maxJournalEvents !== void 0 ? { maxJournalEvents: opts.maxJournalEvents } : {},
        ...opts.maxJournalBytes !== void 0 ? { maxJournalBytes: opts.maxJournalBytes } : {},
        ...journalGrowthPoolBytes !== void 0 ? {
          journalGrowthPoolBytes,
          journalGrowthSessionLimits,
          registerJournalGrowthSessionLimits
        } : {},
        ...opts.channelIdleTimeoutMs !== void 0 ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs } : {},
        ...opts.initializeTimeoutMs !== void 0 ? { initializeTimeoutMs: opts.initializeTimeoutMs } : {},
        sessionRestoreTimeoutMs,
        ...opts.sessionReapIntervalMs !== void 0 ? { sessionReapIntervalMs: opts.sessionReapIntervalMs } : {},
        ...opts.sessionIdleTimeoutMs !== void 0 ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs } : {},
        ...opts.sessionPromptSettledCloseGraceMs !== void 0 ? {
          sessionPromptSettledCloseGraceMs: opts.sessionPromptSettledCloseGraceMs
        } : {},
        ...opts.permissionResponseTimeoutMs !== void 0 ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs } : {},
        boundWorkspace: workspaceInput.cwd,
        runtimeEpochSource: runtimeEpochSourceFor(workspaceInput.cwd),
        acquireMcpAuthentication,
        promptLedger: runtime.createPromptLedgerSink(
          workspaceInput.cwd,
          secondaryEnv.sessionRuntimeBaseDir
        ),
        sessionShellCommandEnabled,
        childEnvOverrides,
        channelFactory: secondaryChannelFactory,
        externalToolGuard: daemonToolGuardHandler,
        onDiagnosticLine: diagnosticSink,
        telemetry: createRuntimeBridgeTelemetry(secondaryWorkspaceHash),
        ...permissionPolicy !== void 0 ? { permissionPolicy } : {},
        ...permissionConsensusQuorum !== void 0 ? {
          permissionConsensusQuorum
        } : {},
        permissionAudit: permissionAuditPublisher,
        statusProvider: secondaryStatusProvider,
        delegateReadTextFileToClient: false,
        fileSystem: createBridgeFileSystemAdapter(secondaryBridgeFsFactory, {
          allowSameHostToolWritesOutsideWorkspace: true
        }),
        persistApprovalMode: /* @__PURE__ */ __name((workspace, mode) => withSettingsLock(workspace, async () => {
          secondaryGenerationGuard.assertOpen();
          if (!secondaryTrusted) {
            throw new Error(
              "Cannot persist approval mode for an untrusted workspace."
            );
          }
          const fresh = settingsRuntime.settings.loadSettings(workspace, {
            skipLoadEnvironment: true,
            workspaceTrusted: secondaryTrusted
          });
          secondaryGenerationGuard.assertOpen();
          fresh.setValue(
            WORKSPACE_SETTING_SCOPE,
            "tools.approvalMode",
            mode,
            () => secondaryGenerationGuard.assertOpen()
          );
        }), "persistApprovalMode")
      });
      secondaryBridgeRef = secondaryBridge;
      runtimeBridges.push(secondaryBridge);
      internalRuntimeBridgesForCleanup.push(secondaryBridge);
      subSessionStoppers.push(secondarySubSessionLauncher.stop);
      const secondaryWorkspaceService = runtime.createDaemonWorkspaceService({
        boundWorkspace: workspaceInput.cwd,
        isWorkspaceTrusted: /* @__PURE__ */ __name(() => secondaryTrusted, "isWorkspaceTrusted"),
        assertGenerationOpen: /* @__PURE__ */ __name(() => secondaryGenerationGuard.assertOpen(), "assertGenerationOpen"),
        contextFilename: secondaryContextFilename,
        statusProvider: secondaryStatusProvider,
        workspaceProvidersStatusProvider: runtime.createWorkspaceProvidersStatusProvider({
          env: secondaryEnv.effectiveEnv,
          workspaceTrusted: secondaryTrusted
        }),
        workspaceSkillsStatusProvider: runtime.createWorkspaceSkillsStatusProvider({
          workspaceTrusted: secondaryTrusted
        }),
        skillInstallEnv: secondaryEnv.effectiveEnv,
        voiceEnv: secondaryEnv.effectiveEnv,
        voiceSettingsScope: WORKSPACE_SETTING_SCOPE,
        isChannelLive: /* @__PURE__ */ __name(() => secondaryBridge.isChannelLive(), "isChannelLive"),
        preheatAcpChild: /* @__PURE__ */ __name(() => secondaryBridge.preheat(), "preheatAcpChild"),
        persistDisabledTools: persistDisabledToolsFn,
        persistDisabledSkills: persistDisabledSkillsFn,
        persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
        persistSetting: persistSettingFn,
        persistSettings: persistSettingsFn,
        reloadDaemonEnv: /* @__PURE__ */ __name((workspace, assertGenerationOpen) => withSettingsLock(workspace, async () => {
          assertGenerationOpen?.();
          const fresh = settingsRuntime.settings.loadSettings(workspace, {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: !secondaryTrusted,
            workspaceTrusted: secondaryTrusted
          });
          assertGenerationOpen?.();
          let runtimeEnvironmentApplied = false;
          let refreshedRuntimeEnv;
          try {
            refreshedRuntimeEnv = settingsRuntime.environment.buildRuntimeEnvironment(
              fresh.merged,
              workspace,
              daemonRuntimeBaseEnv,
              secondaryTrusted
            );
          } catch (err) {
            secondaryEnv.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
            daemonLog.warn(
              "failed to rebuild secondary runtime env snapshot before daemon env reload; preserving previous runtime env",
              {
                workspace,
                error: secondaryEnv.metadata.fallbackReason
              }
            );
            return {
              updatedKeys: [],
              removedKeys: [],
              runtimeEnvironmentApplied
            };
          }
          logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
          if (refreshedRuntimeEnv.envFileReadFailed) {
            return {
              updatedKeys: [],
              removedKeys: [],
              runtimeEnvironmentApplied: false
            };
          }
          const result = settingsRuntime.settings.reloadEnvironment(
            fresh.merged,
            workspace,
            secondaryTrusted,
            { failClosedOnEnvFileReadError: true }
          );
          if (result.envFileReadFailed) {
            return {
              updatedKeys: [],
              removedKeys: [],
              runtimeEnvironmentApplied: false
            };
          }
          try {
            secondaryEnv.replace(refreshedRuntimeEnv.effectiveEnv);
            secondaryEnv.metadata.workflowsEnabledBySettings = fresh.merged.tools?.workflowsEnabled === true;
            secondaryEnv.metadata.envFileReadFailed = refreshedRuntimeEnv.envFileReadFailed;
            secondaryEnv.metadata.envFileReadFailures.splice(
              0,
              secondaryEnv.metadata.envFileReadFailures.length,
              ...refreshedRuntimeEnv.envFileReadFailures
            );
            secondaryEnv.metadata.overlayKeys.splice(
              0,
              secondaryEnv.metadata.overlayKeys.length,
              ...refreshedRuntimeEnv.overlayKeys
            );
            secondaryEnv.metadata.envFilePaths.splice(
              0,
              secondaryEnv.metadata.envFilePaths.length,
              ...refreshedRuntimeEnv.envFilePaths
            );
            delete secondaryEnv.metadata.fallbackReason;
            runtimeEnvironmentApplied = true;
            return { ...result, runtimeEnvironmentApplied };
          } catch (err) {
            secondaryEnv.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
            daemonLog.warn(
              "failed to apply secondary runtime env snapshot after daemon env reload; preserving previous runtime env",
              {
                workspace,
                error: secondaryEnv.metadata.fallbackReason
              }
            );
            return { ...result, runtimeEnvironmentApplied };
          }
        }), "reloadDaemonEnv"),
        reloadModelProvidersDaemonEnv: /* @__PURE__ */ __name((workspace, assertGenerationOpen) => reloadRuntimeOverlaySnapshotForModelProviders(
          workspace,
          secondaryTrusted,
          secondaryEnv,
          assertGenerationOpen
        ), "reloadModelProvidersDaemonEnv"),
        queryWorkspaceStatus: /* @__PURE__ */ __name((method, idle) => secondaryBridge.queryWorkspaceStatus(method, idle), "queryWorkspaceStatus"),
        invokeWorkspaceCommand: /* @__PURE__ */ __name((method, params, invokeOpts) => secondaryBridge.invokeWorkspaceCommand(method, params, invokeOpts), "invokeWorkspaceCommand"),
        refreshExtensionsForAllSessions: /* @__PURE__ */ __name(() => secondaryBridge.refreshExtensionsForAllSessions(), "refreshExtensionsForAllSessions"),
        publishWorkspaceEvent: /* @__PURE__ */ __name((event) => secondaryBridge.publishWorkspaceEvent(event), "publishWorkspaceEvent")
      });
      const secondaryRuntime = {
        workspaceId: secondaryWorkspaceHash,
        workspaceCwd: workspaceInput.cwd,
        sessionRuntimeBaseDir: secondaryEnv.sessionRuntimeBaseDir,
        ...workspaceInput.displayName ? { displayName: workspaceInput.displayName } : {},
        primary: false,
        trusted: secondaryTrusted,
        removable: workspaceInput.removable,
        registrationIds: workspaceInput.registrationIds,
        env: secondaryEnv.metadata,
        bridge: secondaryBridge,
        workspaceService: secondaryWorkspaceService,
        routeFileSystemFactory: secondaryBridgeFsFactory,
        clientMcpSenderRegistry: secondaryClientMcpSenderRegistry,
        generationGuard: secondaryGenerationGuard,
        trustMaterialization: JSON.stringify({
          trusted: secondaryTrusted,
          boundWorkspaces: [workspaceInput.cwd]
        })
      };
      subSessionStoppersByRuntime.set(
        secondaryRuntime,
        secondarySubSessionLauncher.stop
      );
      workspaceRuntimes.push(secondaryRuntime);
    }
    const workspaceRegistry = runtime.createWorkspaceRegistry(workspaceRuntimes, {
      sessionOwnerIndex,
      scanUnindexedOwners: deps.bridge !== void 0
    });
    workspaceRegistryForPersistence.current = workspaceRegistry;
    const workspaceVoiceCoordinator = new WorkspaceVoiceCoordinator();
    core.registerDaemonGaugeCallbacks({
      sessionCount: /* @__PURE__ */ __name(() => workspaceRegistry.listAll().reduce((sum, item) => sum + item.bridge.sessionCount, 0), "sessionCount"),
      sseCount: /* @__PURE__ */ __name(() => runtime.getActiveSseCount(), "sseCount"),
      heapUsed: /* @__PURE__ */ __name(() => process.memoryUsage().heapUsed, "heapUsed")
    });
    daemonMetricsSampler?.dispose();
    const metricsLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    metricsLoopDelay.enable();
    const cpuCoreCount = os.availableParallelism?.() ?? os.cpus().length ?? 1;
    let prevCpu = safeCpuUsage();
    let prevCpuAt = Date.now();
    let prevRateRejected;
    const metricsSamplerTimer = setInterval(() => {
      const nowMs = Date.now();
      const eventLoopLagP99Ms = metricsLoopDelay.percentile(99) / 1e6;
      try {
        const mem = process.memoryUsage();
        const cpu = safeCpuUsage();
        const cpuPercent = computeCpuPercent(
          prevCpu,
          cpu,
          nowMs - prevCpuAt,
          cpuCoreCount
        );
        if (cpu) {
          prevCpu = cpu;
          prevCpuAt = nowMs;
        }
        const acp = app2.locals?.["acpHandle"]?.getSnapshot();
        const hits = getRateLimiter(app2)?.getHitCounts();
        const rejectedTotal = hits ? hits.prompt + hits.mutation + hits.read : 0;
        const rateLimitRejected = prevRateRejected === void 0 ? 0 : Math.max(0, rejectedTotal - prevRateRejected);
        prevRateRejected = rejectedTotal;
        const primaryEntry = workspaceRegistry.primaryEntry;
        const primaryRuntimeBridge = primaryEntry.state === "active" ? primaryEntry.current?.runtime.bridge : void 0;
        const child = primaryRuntimeBridge?.getChildResourceSnapshot?.();
        if (runtime.getActiveSseCount() > 0 || (acp?.wsStreams ?? 0) > 0) {
          for (const managed of workspaceRegistry.listManaged()) {
            void managed.bridge.refreshChildResource?.().catch((err) => {
              daemonLog.warn("ACP child resource refresh failed", {
                workspaceId: managed.workspaceId,
                error: err instanceof Error ? err.message : String(err)
              });
            });
          }
        }
        metricsRing.sample(nowMs, {
          cpuPercent,
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          activeSessions: workspaceRegistry.listAll().reduce((sum, item) => sum + item.bridge.sessionCount, 0),
          activePrompts: workspaceRegistry.listAll().reduce(
            (sum, item) => sum + (item.bridge.activePromptCount ?? 0),
            0
          ),
          queuedPrompts: workspaceRegistry.listAll().reduce(
            (sum, item) => sum + (item.bridge.pendingPromptTotal ?? 0),
            0
          ),
          eventLoopLagP99Ms,
          sseConnections: runtime.getActiveSseCount(),
          wsConnections: acp?.wsStreams ?? 0,
          acpConnections: acp?.connectionCount ?? 0,
          rateLimitRejected,
          childCpuPercent: child?.cpuPercent ?? 0,
          childRssBytes: child?.rssBytes ?? 0
        });
      } catch (err) {
        daemonLog.warn(
          `metrics sampler tick failed: ${err instanceof Error ? err.message : String(err)}`
        );
        try {
          metricsRing.sample(nowMs, {
            cpuPercent: 0,
            rssBytes: 0,
            heapUsedBytes: 0,
            activeSessions: 0,
            activePrompts: 0,
            queuedPrompts: 0,
            eventLoopLagP99Ms,
            sseConnections: 0,
            wsConnections: 0,
            acpConnections: 0,
            rateLimitRejected: 0,
            childCpuPercent: 0,
            childRssBytes: 0
          });
        } catch {
        }
      } finally {
        metricsLoopDelay.reset();
      }
    }, DAEMON_METRICS_SAMPLE_MS);
    metricsSamplerTimer.unref();
    daemonMetricsSampler = {
      dispose() {
        clearInterval(metricsSamplerTimer);
        metricsLoopDelay.disable();
      }
    };
    sessionPrRefreshTimer?.dispose();
    const refreshGeneration = ++sessionPrRefreshGeneration;
    void import("./session-pr-refresh-YG3ACLEW.js").then((mod) => {
      if (refreshGeneration !== sessionPrRefreshGeneration) return;
      sessionPrRefreshTimer = mod.startSessionPrRefreshTimer({
        workspaceRegistry,
        // The coordinator lives on the serve app (createServeApp below),
        // which is built after this timer starts; read it per tick like
        // the metrics sampler reads `acpHandle`.
        getArchiveCoordinator: /* @__PURE__ */ __name(() => app2.locals.sessionArchiveCoordinator, "getArchiveCoordinator")
      });
    }).catch((error) => {
      daemonLog.warn(
        `session-pr-refresh load failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const createDynamicWorkspaceRuntime = /* @__PURE__ */ __name(async (cwd, buildOptions) => {
      const provenance = buildOptions?.provenance ?? "existing";
      if (provenance === "managed-scratch" && (!managedScratchRoot || !isManagedScratchChild(cwd, managedScratchRoot.canonicalRoot))) {
        throw new Error(
          "Managed scratch runtime must use an accepted direct child directory"
        );
      }
      if (provenance === "live-conversation") {
        await liveConversationWorkspace.assertExactRoot(cwd);
      }
      const snapshot = buildOptions?.snapshot ?? await trustPolicy.readDaemonTrustPolicySnapshot();
      const decision = buildOptions?.decision ?? trustPolicy.evaluateDaemonWorkspaceTrust(snapshot, cwd);
      const trusted = provenance === "managed-scratch" || provenance === "live-conversation" ? true : buildOptions?.trusted ?? decision.targetTrusted;
      let wsSettings;
      try {
        wsSettings = settingsRuntime.settings.loadSettings(cwd, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trusted,
          workspaceTrusted: trusted
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: could not read full settings for dynamic workspace ${cwd} (${err instanceof Error ? err.message : String(err)}); falling back to defaults.`
        );
      }
      const wsEnv = createRuntimeEnvMetadata(cwd, wsSettings, trusted);
      const wsCustomIgnoreFiles = wsSettings?.merged.context?.fileFiltering?.customIgnoreFiles;
      const wsContextFilename = extractContextFilename(wsSettings?.merged.context?.fileName) ?? contextFilenameForInit ?? "QWEN.md";
      const wsHash = core.hashDaemonWorkspace(cwd);
      const generationGuard = buildOptions?.generationGuard ?? runtime.createWorkspaceGenerationGuard();
      const runtimeBoundWorkspaces = buildOptions?.boundWorkspaces ?? [cwd];
      const wsFsFactory = runtime.resolveBridgeFsFactory({
        boundWorkspaces: runtimeBoundWorkspaces,
        trusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        generationGuard,
        ...wsCustomIgnoreFiles !== void 0 ? { customIgnoreFiles: wsCustomIgnoreFiles } : {}
      });
      const wsRouteFsFactory = buildOptions?.primary === true && runtimeBoundWorkspaces.length > 1 ? runtime.resolveBridgeFsFactory({
        boundWorkspaces: [cwd],
        trusted,
        emit: deps.fsAuditEmit,
        pathLocks: sharedPathLocks,
        generationGuard,
        ...wsCustomIgnoreFiles !== void 0 ? { customIgnoreFiles: wsCustomIgnoreFiles } : {}
      }) : wsFsFactory;
      const wsChannelFactory = runtime.createSpawnChannelFactory({
        processRegistry,
        childHeapPolicy,
        reclaimIdleChild: /* @__PURE__ */ __name(async (signal) => {
          await idleReclaimerRef.current?.(wsHash, signal);
        }, "reclaimIdleChild"),
        pipeLimits: runtime.daemonAcpNdJsonLimits,
        sourceEnv: wsEnv.effectiveEnv,
        onDiagnosticLine: diagnosticSink,
        pipeHooks: {
          onMessageSent: /* @__PURE__ */ __name((bytes) => recordPipeMessage("outbound", bytes), "onMessageSent"),
          onMessageReceived: /* @__PURE__ */ __name((bytes) => recordPipeMessage("inbound", bytes), "onMessageReceived"),
          onMessageObserved: /* @__PURE__ */ __name(({ direction, bytes, message }) => observeLargePipeFrame({
            direction: daemonPipeDirection(direction),
            bytes,
            message
          }), "onMessageObserved"),
          onQueueSaturated: warnAcpQueueSaturated
        },
        ...acpChildExtraArgs(opts) ? { extraArgs: acpChildExtraArgs(opts) } : {}
      });
      const wsClientMcpRegistry = new ClientMcpSenderRegistry();
      let wsBridgeRef;
      const wsSubSessionLauncher = createSubSessionLauncher({
        getBridge: /* @__PURE__ */ __name(() => wsBridgeRef, "getBridge"),
        boundWorkspace: cwd,
        runtimeBaseDir: wsEnv.sessionRuntimeBaseDir,
        ...provenance === "live-conversation" ? {
          notifySentCompletion: true,
          getStandaloneSessionService: /* @__PURE__ */ __name(() => (runtimeApp ?? runtimeAppForCleanup)?.locals?.["standaloneSessionService"], "getStandaloneSessionService"),
          isolatedWorkspace: {
            materializeDirectory: /* @__PURE__ */ __name((sessionId) => liveConversationWorkspace.materializeConversationDirectory(
              sessionId
            ), "materializeDirectory"),
            discardEmptyDirectory: /* @__PURE__ */ __name((sessionId) => liveConversationWorkspace.discardEmptyConversationDirectory(
              sessionId
            ), "discardEmptyDirectory")
          }
        } : {},
        ...subSessionConcurrencyCapsFromSettings(
          wsSettings?.merged.serve ?? {}
        )
      });
      let wsBridge;
      try {
        const wsAttachmentsRoots = sessionAttachmentsRoots(
          cwd,
          wsEnv.sessionRuntimeBaseDir
        );
        wsBridge = runtime.createAcpSessionBridge({
          artifactSnapshotRuntimeBaseDir: wsEnv.sessionRuntimeBaseDir,
          sessionAttachmentsRoot: wsAttachmentsRoots.root,
          sessionAttachmentsFallbackRoot: wsAttachmentsRoots.fallback,
          clientMcpSender: wsClientMcpRegistry.lookup,
          onCreateSubSession: wsSubSessionLauncher.launch,
          onCreateCurrentSessionScheduledTask: createCurrentSessionScheduledTaskHandler(
            cwd,
            wsEnv.sessionRuntimeBaseDir,
            () => wsBridgeRef,
            () => generationGuard.assertOpen()
          ),
          onChannelDelivery: createBoundChannelDeliveryHandler(
            cwd,
            () => channelWorkerManager,
            channelDeliveryAuthorizations,
            daemonLog,
            channelDeliveryDiagnosticRedaction
          ),
          maxSessions: opts.maxSessions,
          ...opts.restoreAskUserQuestion === true ? { restoreAskUserQuestion: true } : {},
          freshSessionAdmission: totalSessionAdmission.admit,
          sessionLifecycle: /* @__PURE__ */ __name((event) => {
            if (event.type === "registered" && generationGuard.closed) return;
            sessionOwnerIndex.handleBridgeSessionLifecycle(event);
          }, "sessionLifecycle"),
          ...opts.maxPendingPromptsPerSession !== void 0 ? { maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession } : {},
          ...opts.eventRingSize !== void 0 ? { eventRingSize: opts.eventRingSize } : {},
          ...opts.compactedReplayMaxBytes !== void 0 ? { compactedReplayMaxBytes: opts.compactedReplayMaxBytes } : {},
          ...opts.maxJournalEvents !== void 0 ? { maxJournalEvents: opts.maxJournalEvents } : {},
          ...opts.maxJournalBytes !== void 0 ? { maxJournalBytes: opts.maxJournalBytes } : {},
          ...journalGrowthPoolBytes !== void 0 ? {
            journalGrowthPoolBytes,
            journalGrowthSessionLimits,
            registerJournalGrowthSessionLimits
          } : {},
          ...opts.channelIdleTimeoutMs !== void 0 ? { channelIdleTimeoutMs: opts.channelIdleTimeoutMs } : {},
          ...opts.initializeTimeoutMs !== void 0 ? { initializeTimeoutMs: opts.initializeTimeoutMs } : {},
          sessionRestoreTimeoutMs,
          ...opts.sessionReapIntervalMs !== void 0 ? { sessionReapIntervalMs: opts.sessionReapIntervalMs } : {},
          ...opts.sessionIdleTimeoutMs !== void 0 ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs } : {},
          ...opts.sessionPromptSettledCloseGraceMs !== void 0 ? {
            sessionPromptSettledCloseGraceMs: opts.sessionPromptSettledCloseGraceMs
          } : {},
          ...opts.permissionResponseTimeoutMs !== void 0 ? { permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs } : {},
          boundWorkspace: cwd,
          runtimeEpochSource: runtimeEpochSourceFor(cwd),
          acquireMcpAuthentication,
          // Live-conversation workspaces keep transcripts outside the
          // runtime storage layout, so no ledger sink is wired there.
          ...provenance === "live-conversation" ? {} : {
            promptLedger: runtime.createPromptLedgerSink(
              cwd,
              wsEnv.sessionRuntimeBaseDir
            )
          },
          sessionShellCommandEnabled,
          // Only the Conversations runtime's children carry the private
          // provenance marker; every other workspace keeps the shared
          // overrides' explicit removal.
          childEnvOverrides: provenance === "live-conversation" ? {
            ...childEnvOverrides,
            [PRIVATE_CONVERSATIONS_RUNTIME_ENV]: PRIVATE_CONVERSATIONS_RUNTIME_ENABLE
          } : childEnvOverrides,
          channelFactory: wsChannelFactory,
          externalToolGuard: daemonToolGuardHandler,
          onDiagnosticLine: diagnosticSink,
          telemetry: createRuntimeBridgeTelemetry(wsHash),
          ...permissionPolicy !== void 0 ? { permissionPolicy } : {},
          ...permissionConsensusQuorum !== void 0 ? {
            permissionConsensusQuorum
          } : {},
          permissionAudit: permissionAuditPublisher,
          statusProvider: runtime.createDaemonStatusProvider({
            env: wsEnv.effectiveEnv
          }),
          delegateReadTextFileToClient: false,
          fileSystem: createBridgeFileSystemAdapter(wsFsFactory, {
            allowSameHostToolWritesOutsideWorkspace: true
          }),
          persistApprovalMode: /* @__PURE__ */ __name((workspace, mode) => withSettingsLock(workspace, async () => {
            generationGuard.assertOpen();
            if (!trusted) {
              throw new Error(
                "Cannot persist approval mode for an untrusted workspace."
              );
            }
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
              workspaceTrusted: trusted
            });
            generationGuard.assertOpen();
            fresh.setValue(
              WORKSPACE_SETTING_SCOPE,
              "tools.approvalMode",
              mode,
              () => generationGuard.assertOpen()
            );
          }), "persistApprovalMode")
        });
      } catch (err) {
        wsSubSessionLauncher.stop();
        throw err;
      }
      wsBridgeRef = wsBridge;
      let wsService;
      try {
        wsService = runtime.createDaemonWorkspaceService({
          boundWorkspace: cwd,
          isWorkspaceTrusted: /* @__PURE__ */ __name(() => trusted, "isWorkspaceTrusted"),
          assertGenerationOpen: /* @__PURE__ */ __name(() => generationGuard.assertOpen(), "assertGenerationOpen"),
          contextFilename: wsContextFilename,
          statusProvider: runtime.createDaemonStatusProvider({
            env: wsEnv.effectiveEnv
          }),
          workspaceProvidersStatusProvider: runtime.createWorkspaceProvidersStatusProvider({
            env: wsEnv.effectiveEnv,
            workspaceTrusted: trusted
          }),
          workspaceSkillsStatusProvider: runtime.createWorkspaceSkillsStatusProvider({
            workspaceTrusted: trusted
          }),
          skillInstallEnv: wsEnv.effectiveEnv,
          voiceEnv: wsEnv.effectiveEnv,
          ...buildOptions?.primary === true ? {} : { voiceSettingsScope: WORKSPACE_SETTING_SCOPE },
          isChannelLive: /* @__PURE__ */ __name(() => wsBridge.isChannelLive(), "isChannelLive"),
          preheatAcpChild: /* @__PURE__ */ __name(() => wsBridge.preheat(), "preheatAcpChild"),
          persistDisabledTools: persistDisabledToolsFn,
          persistDisabledSkills: persistDisabledSkillsFn,
          persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
          persistSetting: persistSettingFn,
          persistSettings: persistSettingsFn,
          reloadDaemonEnv: /* @__PURE__ */ __name((workspace, assertGenerationOpen) => withSettingsLock(workspace, async () => {
            assertGenerationOpen?.();
            const fresh = settingsRuntime.settings.loadSettings(workspace, {
              skipLoadEnvironment: true,
              skipWorkspaceSettings: !trusted,
              workspaceTrusted: trusted
            });
            assertGenerationOpen?.();
            let runtimeEnvironmentApplied = false;
            let refreshedRuntimeEnv;
            try {
              refreshedRuntimeEnv = settingsRuntime.environment.buildRuntimeEnvironment(
                fresh.merged,
                workspace,
                daemonRuntimeBaseEnv,
                trusted
              );
            } catch (err) {
              wsEnv.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
              daemonLog.warn(
                "failed to rebuild dynamic runtime env snapshot before daemon env reload; preserving previous runtime env",
                {
                  workspace,
                  error: wsEnv.metadata.fallbackReason
                }
              );
              return {
                updatedKeys: [],
                removedKeys: [],
                runtimeEnvironmentApplied
              };
            }
            logRuntimeEnvFileReadFailures(workspace, refreshedRuntimeEnv);
            if (refreshedRuntimeEnv.envFileReadFailed) {
              return {
                updatedKeys: [],
                removedKeys: [],
                runtimeEnvironmentApplied: false
              };
            }
            const result = settingsRuntime.settings.reloadEnvironment(
              fresh.merged,
              workspace,
              trusted,
              { failClosedOnEnvFileReadError: true }
            );
            if (result.envFileReadFailed) {
              return {
                updatedKeys: [],
                removedKeys: [],
                runtimeEnvironmentApplied: false
              };
            }
            try {
              wsEnv.replace(refreshedRuntimeEnv.effectiveEnv);
              wsEnv.metadata.workflowsEnabledBySettings = fresh.merged.tools?.workflowsEnabled === true;
              wsEnv.metadata.envFileReadFailed = refreshedRuntimeEnv.envFileReadFailed;
              wsEnv.metadata.envFileReadFailures.splice(
                0,
                wsEnv.metadata.envFileReadFailures.length,
                ...refreshedRuntimeEnv.envFileReadFailures
              );
              wsEnv.metadata.overlayKeys.splice(
                0,
                wsEnv.metadata.overlayKeys.length,
                ...refreshedRuntimeEnv.overlayKeys
              );
              wsEnv.metadata.envFilePaths.splice(
                0,
                wsEnv.metadata.envFilePaths.length,
                ...refreshedRuntimeEnv.envFilePaths
              );
              delete wsEnv.metadata.fallbackReason;
              runtimeEnvironmentApplied = true;
              return { ...result, runtimeEnvironmentApplied };
            } catch (err) {
              wsEnv.metadata.fallbackReason = err instanceof Error ? err.message : String(err);
              daemonLog.warn(
                "failed to apply dynamic runtime env snapshot after daemon env reload; preserving previous runtime env",
                {
                  workspace,
                  error: wsEnv.metadata.fallbackReason
                }
              );
              return { ...result, runtimeEnvironmentApplied };
            }
          }), "reloadDaemonEnv"),
          ...buildOptions?.primary === true ? {} : {
            reloadModelProvidersDaemonEnv: /* @__PURE__ */ __name((workspace, assertGenerationOpen) => reloadRuntimeOverlaySnapshotForModelProviders(
              workspace,
              trusted,
              wsEnv,
              assertGenerationOpen
            ), "reloadModelProvidersDaemonEnv")
          },
          queryWorkspaceStatus: /* @__PURE__ */ __name((method, idle) => wsBridge.queryWorkspaceStatus(method, idle), "queryWorkspaceStatus"),
          invokeWorkspaceCommand: /* @__PURE__ */ __name((method, params, invokeOpts) => wsBridge.invokeWorkspaceCommand(method, params, invokeOpts), "invokeWorkspaceCommand"),
          refreshExtensionsForAllSessions: /* @__PURE__ */ __name(() => wsBridge.refreshExtensionsForAllSessions(), "refreshExtensionsForAllSessions"),
          publishWorkspaceEvent: /* @__PURE__ */ __name((event) => {
            if (buildOptions?.primary === true && (event.type === "settings_changed" || event.type === "settings_reloaded")) {
              invalidatePrimaryServeFeaturesCache();
            }
            wsBridge.publishWorkspaceEvent(event);
          }, "publishWorkspaceEvent")
        });
      } catch (err) {
        wsSubSessionLauncher.stop();
        await wsBridge.shutdown().catch(() => {
          try {
            wsBridge.killAllSync();
          } catch {
          }
        });
        throw err;
      }
      runtimeBridges.push(wsBridge);
      internalRuntimeBridgesForCleanup.push(wsBridge);
      subSessionStoppers.push(wsSubSessionLauncher.stop);
      const wsRuntime = {
        workspaceId: wsHash,
        workspaceCwd: cwd,
        sessionRuntimeBaseDir: wsEnv.sessionRuntimeBaseDir,
        ...buildOptions?.displayName !== void 0 ? { displayName: buildOptions.displayName } : provenance === "live-conversation" ? { displayName: "Conversations" } : {},
        primary: buildOptions?.primary ?? false,
        trusted,
        provenance,
        removable: buildOptions?.removable ?? provenance !== "live-conversation",
        registrationIds: [...buildOptions?.registrationIds ?? []],
        env: wsEnv.metadata,
        bridge: wsBridge,
        workspaceService: wsService,
        routeFileSystemFactory: wsRouteFsFactory,
        clientMcpSenderRegistry: wsClientMcpRegistry,
        generationGuard,
        trustMaterialization: buildOptions?.trustMaterialization ?? JSON.stringify({
          trusted,
          boundWorkspaces: [...runtimeBoundWorkspaces].sort()
        })
      };
      subSessionStoppersByRuntime.set(wsRuntime, wsSubSessionLauncher.stop);
      if (provenance === "existing" && !buildOptions?.snapshot) {
        const latest = await trustPolicy.readDaemonTrustPolicySnapshot();
        if (latest.revision !== snapshot.revision) {
          generationGuard.close();
          wsSubSessionLauncher.stop();
          await wsBridge.shutdown({ reason: "trust_reconfigured" }).catch(() => {
            try {
              wsBridge.killAllSync();
            } catch {
            }
          });
          subSessionStoppersByRuntime.delete(wsRuntime);
          removeArrayValue(subSessionStoppers, wsSubSessionLauncher.stop);
          removeArrayValue(runtimeBridges, wsBridge);
          removeArrayValue(internalRuntimeBridgesForCleanup, wsBridge);
          if ((buildOptions?.validationAttempt ?? 0) >= 2) {
            throw new Error(
              "Workspace trust policy kept changing during runtime creation."
            );
          }
          const { generationGuard: _staleGuard, ...retryOptions } = buildOptions ?? {};
          return createDynamicWorkspaceRuntime(cwd, {
            ...retryOptions,
            validationAttempt: (buildOptions?.validationAttempt ?? 0) + 1
          });
        }
      }
      return wsRuntime;
    }, "createDynamicWorkspaceRuntime");
    const serveAppForRuntimeLifecycle = { current: void 0 };
    const workspaceRuntimeRemoval = {
      async runtimeAdded(runtimeAdded) {
        const app3 = serveAppForRuntimeLifecycle.current ?? runtimeApp ?? runtimeAppForCleanup;
        const startScheduledTaskKeepaliveForWorkspace = app3?.locals?.["startScheduledTaskKeepaliveForWorkspace"];
        startScheduledTaskKeepaliveForWorkspace?.(runtimeAdded);
        if (runtimeAdded.provenance === "live-conversation") return;
        channelWebhookEnvByWorkspace.set(
          runtimeAdded.workspaceCwd,
          workspaceRuntimeEffectiveEnv(runtimeAdded, daemonRuntimeBaseEnv)
        );
        channelWebhookConfigVersion += 1;
        refreshChannelWebhookConfigs?.();
        if (!channelWorkerManager) return;
        try {
          if (runtimeAdded.trusted) {
            await channelWorkerManager.restoreWorkspace(
              runtimeAdded.workspaceCwd
            );
          }
          await channelWorkerManager.refreshWorkspaces();
        } catch (err) {
          daemonLog.error(
            "workspace channel worker startup error",
            err instanceof Error ? err : null
          );
        } finally {
          writeChannelWorkerPidfile();
        }
      },
      beginDrain(runtimeToDrain) {
        if (runtimeToDrain.primary) {
          if (bridgeRef === runtimeToDrain.bridge) bridgeRef = void 0;
          invalidatePrimaryServeFeaturesCache();
        }
        totalSessionAdmission.beginWorkspaceDrain(runtimeToDrain.workspaceCwd);
        if (runtimeToDrain.provenance !== "live-conversation") {
          channelWorkerManager?.beginWorkspaceDrain(
            runtimeToDrain.workspaceCwd
          );
        }
        workspaceVoiceCoordinator.beginWorkspaceDrain(runtimeToDrain);
        channelWebhookEnvByWorkspace.delete(runtimeToDrain.workspaceCwd);
        channelWebhookConfigVersion += 1;
        refreshChannelWebhookConfigs?.();
        const app3 = serveAppForRuntimeLifecycle.current ?? runtimeApp ?? runtimeAppForCleanup;
        const stopScheduledTaskKeepaliveForWorkspace = app3?.locals?.["stopScheduledTaskKeepaliveForWorkspace"];
        try {
          stopScheduledTaskKeepaliveForWorkspace?.(runtimeToDrain.workspaceCwd);
        } catch (err) {
          daemonLog.error(
            "workspace scheduled-task drain error",
            err instanceof Error ? err : null
          );
        }
      },
      cancelDrain(runtimeToDrain) {
        if (runtimeToDrain.primary && bridgeRef === void 0) {
          bridgeRef = runtimeToDrain.bridge;
          invalidatePrimaryServeFeaturesCache();
        }
        if (runtimeToDrain.provenance !== "live-conversation") {
          channelWorkerManager?.cancelWorkspaceDrain(
            runtimeToDrain.workspaceCwd
          );
        }
        totalSessionAdmission.cancelWorkspaceDrain(runtimeToDrain.workspaceCwd);
        workspaceVoiceCoordinator.cancelWorkspaceDrain(runtimeToDrain);
        if (runtimeToDrain.provenance !== "live-conversation") {
          channelWebhookEnvByWorkspace.set(
            runtimeToDrain.workspaceCwd,
            workspaceRuntimeEffectiveEnv(runtimeToDrain, daemonRuntimeBaseEnv)
          );
          channelWebhookConfigVersion += 1;
          refreshChannelWebhookConfigs?.();
        }
        const app3 = serveAppForRuntimeLifecycle.current ?? runtimeApp ?? runtimeAppForCleanup;
        const startScheduledTaskKeepaliveForWorkspace = app3?.locals?.["startScheduledTaskKeepaliveForWorkspace"];
        try {
          startScheduledTaskKeepaliveForWorkspace?.(runtimeToDrain);
        } catch (err) {
          daemonLog.error(
            "workspace scheduled-task drain rollback error",
            err instanceof Error ? err : null
          );
        }
      },
      completeDrain(runtimeToDrain) {
        totalSessionAdmission.completeWorkspaceDrain(
          runtimeToDrain.workspaceCwd
        );
        workspaceVoiceCoordinator.completeWorkspaceDrain(runtimeToDrain);
      },
      getActivity(runtimeToDrain) {
        return {
          pendingSessionStarts: totalSessionAdmission.snapshotForWorkspace(
            runtimeToDrain.workspaceCwd
          ).inFlight,
          channelWorkers: runtimeToDrain.provenance === "live-conversation" ? 0 : channelWorkerManager?.workspaceActivity(
            runtimeToDrain.workspaceCwd
          ) ?? 0,
          voiceSessions: workspaceVoiceCoordinator.getWorkspaceActivity(runtimeToDrain)
        };
      },
      disposeRuntime(runtimeToDrain, reason = "workspace_removed") {
        const existing = runtimeCleanupPromises.get(runtimeToDrain);
        if (existing) return existing;
        const cleanup = (async () => {
          runtime.getWorkspaceRuntimeCoordinatorIfSupported(runtimeToDrain)?.dispose();
          const containmentErrors = [];
          try {
            await workspaceVoiceCoordinator.disposeRuntime(
              runtimeToDrain,
              reason
            );
          } catch (err) {
            daemonLog.error(
              "workspace voice cleanup error",
              err instanceof Error ? err : null
            );
          }
          if (reason === "trust_reconfigured" && workspaceVoiceCoordinator.getWorkspaceActivity(runtimeToDrain) > 0) {
            containmentErrors.push(
              new Error("Workspace voice sessions are still active.")
            );
          }
          const stopSubSessions = subSessionStoppersByRuntime.get(runtimeToDrain);
          try {
            stopSubSessions?.();
          } catch {
          }
          if (reason !== "daemon_shutdown" && channelWorkerManager && runtimeToDrain.provenance !== "live-conversation") {
            await channelWorkerManager.removeWorkspace(runtimeToDrain.workspaceCwd, {
              permanent: reason === "workspace_removed"
            }).catch((err) => {
              daemonLog.error(
                "workspace channel worker cleanup error",
                err instanceof Error ? err : null
              );
            });
            try {
              await channelWorkerManager.refreshWorkspaces();
            } catch (err) {
              channelWorkspaceGroups = (channelWorkspaceGroups ?? []).filter(
                (group) => group.workspaceCwd !== runtimeToDrain.workspaceCwd
              );
              channelWebhookConfigVersion += 1;
              refreshChannelWebhookConfigs?.();
              daemonLog.error(
                "workspace channel worker topology refresh error",
                err instanceof Error ? err : null
              );
            }
            writeChannelWorkerPidfile();
            if (reason === "trust_reconfigured" && channelWorkerManager.workspaceActivity(
              runtimeToDrain.workspaceCwd
            ) > 0) {
              containmentErrors.push(
                new Error("Workspace channel workers are still active.")
              );
            }
          }
          if (reason !== "daemon_shutdown") {
            const app3 = serveAppForRuntimeLifecycle.current ?? runtimeApp ?? runtimeAppForCleanup;
            const stopWorkspaceGitStateForWorkspace = app3?.locals?.["stopWorkspaceGitStateForWorkspace"];
            const stopScheduledTaskKeepaliveForWorkspace = app3?.locals?.["stopScheduledTaskKeepaliveForWorkspace"];
            const releaseWebTerminalsForWorkspace = app3?.locals?.["releaseWebTerminalsForWorkspace"];
            try {
              stopWorkspaceGitStateForWorkspace?.(runtimeToDrain.workspaceCwd);
            } catch (err) {
              daemonLog.error(
                "workspace git-state cleanup error",
                err instanceof Error ? err : null
              );
            }
            try {
              stopScheduledTaskKeepaliveForWorkspace?.(
                runtimeToDrain.workspaceCwd
              );
            } catch (err) {
              daemonLog.error(
                "workspace scheduled-task cleanup error",
                err instanceof Error ? err : null
              );
            }
            try {
              releaseWebTerminalsForWorkspace?.(runtimeToDrain.workspaceCwd);
            } catch (err) {
              daemonLog.error(
                "workspace web-terminal cleanup error",
                err instanceof Error ? err : null
              );
            }
          }
          let bridgeStopped = false;
          try {
            if (!shutdownBridges.has(runtimeToDrain.bridge)) {
              try {
                await runtimeToDrain.bridge.shutdown({ reason });
              } catch (shutdownError) {
                try {
                  runtimeToDrain.bridge.killAllSync();
                  daemonLog.warn(
                    "workspace bridge required forceful shutdown",
                    {
                      workspace: runtimeToDrain.workspaceCwd,
                      reason,
                      error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
                    }
                  );
                } catch (killError) {
                  throw new AggregateError(
                    [shutdownError, killError],
                    "Workspace bridge shutdown could not be confirmed."
                  );
                }
              }
            }
            bridgeStopped = true;
          } finally {
            if (bridgeStopped) {
              subSessionStoppersByRuntime.delete(runtimeToDrain);
              if (stopSubSessions) {
                removeArrayValue(subSessionStoppers, stopSubSessions);
              }
              removeArrayValue(runtimeBridges, runtimeToDrain.bridge);
              removeArrayValue(
                internalRuntimeBridgesForCleanup,
                runtimeToDrain.bridge
              );
              shutdownBridges.add(runtimeToDrain.bridge);
            }
          }
          if (containmentErrors.length > 0) {
            throw new AggregateError(
              containmentErrors,
              "Workspace runtime containment could not be confirmed."
            );
          }
        })();
        runtimeCleanupPromises.set(runtimeToDrain, cleanup);
        void cleanup.catch(() => {
          if (runtimeCleanupPromises.get(runtimeToDrain) === cleanup) {
            runtimeCleanupPromises.delete(runtimeToDrain);
          }
        });
        return cleanup;
      }
    };
    const channelManagementServices = /* @__PURE__ */ new WeakMap();
    const channelManagementService = /* @__PURE__ */ __name((targetRuntime) => {
      const existing = channelManagementServices.get(targetRuntime);
      if (existing) return existing;
      const pending = (async () => {
        if (!ensureChannelWorkerManager) {
          throw Object.assign(
            new Error("Channel worker manager is unavailable."),
            { code: "channel_worker_unavailable" }
          );
        }
        const [
          { createChannelManagementService },
          { WorkspaceChannelSettingsStore }
        ] = await Promise.all([
          import("./channel-management-service-VF24FRX7.js"),
          import("./channel-settings-store-XYUF5OLR.js")
        ]);
        return createChannelManagementService({
          workspaceCwd: targetRuntime.workspaceCwd,
          store: new WorkspaceChannelSettingsStore(targetRuntime.workspaceCwd),
          manager: await ensureChannelWorkerManager()
        });
      })();
      channelManagementServices.set(targetRuntime, pending);
      void pending.catch(() => {
        if (channelManagementServices.get(targetRuntime) === pending) {
          channelManagementServices.delete(targetRuntime);
        }
      });
      return pending;
    }, "channelManagementService");
    const validateWorkspaceRuntimeForPublication = /* @__PURE__ */ __name(async (runtimeForPublication) => {
      let candidate = runtimeForPublication;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await trustPolicy.readDaemonTrustPolicySnapshot();
        const decision = trustPolicy.evaluateDaemonWorkspaceTrust(
          snapshot,
          candidate.workspaceCwd
        );
        const materialization = JSON.stringify({
          trusted: decision.targetTrusted,
          boundWorkspaces: [candidate.workspaceCwd]
        });
        if (candidate.trustMaterialization === materialization) {
          return candidate;
        }
        candidate.generationGuard?.close();
        await workspaceRuntimeRemoval.disposeRuntime(
          candidate,
          "trust_reconfigured"
        );
        if (attempt === 2) {
          throw new Error(
            "Workspace trust policy kept changing before runtime publication."
          );
        }
        candidate = await createDynamicWorkspaceRuntime(
          runtimeForPublication.workspaceCwd,
          {
            primary: runtimeForPublication.primary,
            removable: runtimeForPublication.removable,
            displayName: runtimeForPublication.displayName,
            registrationIds: runtimeForPublication.registrationIds
          }
        );
      }
      throw new Error("Workspace runtime publication validation failed.");
    }, "validateWorkspaceRuntimeForPublication");
    const app2 = runtime.createServeApp(opts, () => actualPort, {
      maxChannelControlWorkspaces: MAX_CHANNEL_CONTROL_WORKSPACES,
      serveAppLifecycle,
      liveDiscoveryStableBaseDir,
      workspaceRegistry,
      getSessionBridges: /* @__PURE__ */ __name(() => runtimeBridges, "getSessionBridges"),
      createWorkspaceRuntime: createDynamicWorkspaceRuntime,
      ...workspaceTrustHotReloadAvailable ? {
        validateWorkspaceRuntimeForPublication,
        runWorkspaceTrustOperation,
        getWorkspaceTrustPolicySnapshot: /* @__PURE__ */ __name(() => latestTrustPolicySnapshot, "getWorkspaceTrustPolicySnapshot")
      } : {},
      managedScratchRoot,
      liveConversationWorkspace,
      readLiveConversationScheduledTasks,
      workspaceRegistrationStore,
      workspaceRuntimeRemoval,
      workspaceTrustHotReloadAvailable,
      voiceCoordinator: workspaceVoiceCoordinator,
      bridge,
      webShellDir,
      boundWorkspace,
      qwenCodeVersion: resolvedCliVersion,
      startup,
      // The real long-running daemon keeps scheduled-task sessions resident
      // (keepalive) and reloads them on boot (rehydration). Off by default so
      // direct createServeApp embeds/tests don't spawn sessions.
      manageScheduledTaskSessions: true,
      currentSessionSchedulingAvailable: deps.bridge === void 0,
      fsFactory: routeFsFactory,
      primaryWorkspaceTrusted: trustedWorkspace,
      primaryRuntimeEnv,
      daemonEnv: daemonRuntimeBaseEnv,
      modelSelectionBaseEnv: getEnvironmentBeforeLoad() ?? daemonRuntimeBaseEnv,
      runtimePlatform: deps.runtimePlatform,
      daemonLog,
      getChannelWorkerSnapshot,
      getChannelWorkerSnapshots,
      getChannelWorkerControl,
      isChannelControlDraining: /* @__PURE__ */ __name(() => channelControlDraining, "isChannelControlDraining"),
      isChannelControlInitializing: /* @__PURE__ */ __name(() => channelWorkerManagerStarting !== void 0, "isChannelControlInitializing"),
      setChannelWorkerSelection,
      stopChannelWorker,
      getChannelWebhookConfigSources,
      getChannelWebhookConfigVersion: /* @__PURE__ */ __name(() => channelWebhookConfigVersion, "getChannelWebhookConfigVersion"),
      registerChannelWebhookConfigRefresh: /* @__PURE__ */ __name((refresh) => {
        refreshChannelWebhookConfigs = refresh;
      }, "registerChannelWebhookConfigRefresh"),
      enqueueChannelWebhookTask: /* @__PURE__ */ __name(async (task) => {
        if (!channelWorkerManager) {
          throw new ChannelWebhookEnqueueError(
            "channel_worker_unavailable",
            "Channel worker is not running."
          );
        }
        return channelWorkerManager.enqueueWebhookTask(task);
      }, "enqueueChannelWebhookTask"),
      deliverChannelMessage: /* @__PURE__ */ __name(async (workspaceCwd, request) => {
        if (!channelWorkerManager) {
          throw new ChannelDeliveryError(
            "channel_worker_unavailable",
            "Channel worker is not running."
          );
        }
        return channelWorkerManager.deliverChannelMessage(
          workspaceCwd,
          request
        );
      }, "deliverChannelMessage"),
      channelDeliveryAuthorizations,
      reloadChannelWorker,
      channelManagementService,
      getPerfSnapshot: /* @__PURE__ */ __name(() => ({
        eventLoop: currentDaemonEventLoopMonitor.snapshot(),
        promptQueueWait: {
          count: promptQueueWaitStats.count,
          meanMs: promptQueueWaitStats.count === 0 ? 0 : promptQueueWaitStats.totalMs / promptQueueWaitStats.count,
          maxMs: promptQueueWaitStats.maxMs,
          lastMs: promptQueueWaitStats.lastMs
        },
        pipe: {
          inbound: { ...pipeStats.inbound },
          outbound: { ...pipeStats.outbound }
        }
      }), "getPerfSnapshot"),
      getMetricsSeries: /* @__PURE__ */ __name(() => metricsRing.snapshot(), "getMetricsSeries"),
      getTotalSessionAdmissionSnapshot: totalSessionAdmission.snapshot,
      getChildHeapPolicySnapshot: /* @__PURE__ */ __name(() => managedChildHeapPolicy?.snapshot(), "getChildHeapPolicySnapshot"),
      ...childHeapPolicy ? {
        managedChildProcesses: {
          registry: processRegistry,
          policy: childHeapPolicy,
          ownsBridge: /* @__PURE__ */ __name((candidate) => runtimeBridges.includes(candidate), "ownsBridge")
        }
      } : {},
      recordDaemonRequest: /* @__PURE__ */ __name((durationMs, statusCode) => metricsRing.recordRequest(durationMs, statusCode), "recordDaemonRequest"),
      workspace: workspaceService,
      // Reverse tool channel (#5626): the SAME registry wired into `bridge` above,
      // so the WS provider and the child-answering bridge share one sender map.
      clientMcpSenderRegistry,
      persistDisabledTools: persistDisabledToolsFn,
      persistDisabledSkills: persistDisabledSkillsFn,
      persistDisabledSkillsBatch: persistDisabledSkillsBatchFn,
      persistSetting: persistSettingFn,
      persistSettings: persistSettingsFn,
      sessionArtifactsPersistenceAvailable: sessionArtifactsPersistenceAvailableFromSettings(
        runtimeBootSettings?.merged
      ),
      updateModelContextWindow: /* @__PURE__ */ __name((workspace, key, size, assertGenerationOpen) => withSettingsLock(workspace, async () => {
        assertGenerationOpen();
        const { updateModelContextWindow } = await import("./model-configuration-OF5KKLFP.js");
        return updateModelContextWindow(
          loadSettingsForPersistence(workspace),
          key,
          size,
          assertGenerationOpen
        );
      }), "updateModelContextWindow"),
      installAuthProvider: /* @__PURE__ */ __name((req, assertGenerationOpen) => withSettingsLock(
        boundWorkspace,
        async () => {
          assertGenerationOpen?.();
          const provider = core.findProviderById(req.providerId);
          if (!provider) {
            throw new Error(`Unsupported auth provider: ${req.providerId}`);
          }
          const inputs = buildProviderSetupInputs(req, provider, {
            getDefaultModelIds: core.getDefaultModelIds,
            resolveBaseUrl: core.resolveBaseUrl
          });
          const fresh = loadSettingsForPersistence(boundWorkspace);
          const plan = core.buildInstallPlan(
            provider,
            inputs,
            core.getModelsForProviderProtocol(
              fresh.merged.modelProviders,
              inputs.protocol ?? provider.protocol,
              fresh.merged.providerProtocol
            ),
            {
              authType: fresh.merged.security?.auth?.selectedType,
              id: fresh.merged.model?.name,
              baseUrl: fresh.merged.model?.baseUrl
            }
          );
          const adapter = settingsRuntime.loadedSettingsAdapter.createLoadedSettingsAdapter(
            fresh
          );
          const { getAuthTypeFromEnv } = await import("./modelConfigUtils-A5MB5ZX6.js");
          const hasConversationAuth = adapter.getValue("security.auth.selectedType") || getAuthTypeFromEnv(primaryRuntimeEnv.effectiveEnv);
          await core.applyProviderInstallPlan(plan, {
            settings: adapter,
            doRefreshAuth: false
          });
          assertGenerationOpen?.();
          core.emitDaemonLog("Auth provider installed.", {
            "qwen-code.daemon.auth.provider_id": provider.id,
            "qwen-code.daemon.auth.auth_type": plan.authType
          });
          const effectiveModelId = adapter.getValue("model.name") ?? plan.modelSelection?.modelId;
          const effectiveBaseUrl = adapter.getValue("model.baseUrl") ?? plan.modelSelection?.baseUrl ?? inputs.baseUrl;
          return {
            v: 1,
            providerId: provider.id,
            providerLabel: provider.label,
            authType: plan.authType,
            ...effectiveModelId ? { modelId: effectiveModelId } : {},
            ...effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {},
            message: !plan.modelSelection ? hasConversationAuth ? "Service models saved." : "Service models saved. Configure a conversation model to start chatting." : `Successfully configured ${provider.label}. Use /model to switch models.`
          };
        }
      ), "installAuthProvider")
    });
    idleReclaimerRef.current = app2.locals["reclaimIdleAcp"];
    serveAppForRuntimeLifecycle.current = app2;
    invalidatePrimaryServeFeaturesCache = app2.locals.invalidateServeFeaturesCache ?? invalidatePrimaryServeFeaturesCache;
    app2.locals.subSessionStoppers = subSessionStoppers;
    subSessionStoppers.push(subSessionLauncher.stop);
    subSessionStoppersByRuntime.set(
      workspaceRegistry.primary,
      subSessionLauncher.stop
    );
    if (workspaceTrustHotReloadAvailable) {
      const [
        { createWorkspaceTrustReconciler },
        { createDaemonTrustPolicyMonitor }
      ] = await Promise.all([
        import("./workspace-trust-reconciler-O3PAASFM.js"),
        import("./daemon-trust-policy-monitor-4HPDXYQ5.js")
      ]);
      const materializationFor = /* @__PURE__ */ __name((entry, snapshot, decision) => {
        const boundWorkspaces2 = entry.primary && decision.targetTrusted ? runtime.resolveBoundWorkspacesFromIdeEnv(
          entry.workspaceCwd,
          void 0,
          (workspace, index) => index === 0 || trustPolicy.evaluateDaemonWorkspaceTrust(snapshot, workspace).targetTrusted
        ) : [entry.workspaceCwd];
        return {
          key: JSON.stringify({
            trusted: decision.targetTrusted,
            boundWorkspaces: [...boundWorkspaces2].sort()
          }),
          boundWorkspaces: boundWorkspaces2
        };
      }, "materializationFor");
      const acpHandle = /* @__PURE__ */ __name(() => app2.locals?.["acpHandle"], "acpHandle");
      const trustReconciler = createWorkspaceTrustReconciler({
        registry: workspaceRegistry,
        readLatestSnapshot: trustPolicy.readDaemonTrustPolicySnapshot,
        materializationKey: /* @__PURE__ */ __name(({ entry, snapshot, decision }) => materializationFor(entry, snapshot, decision).key, "materializationKey"),
        isTrustDecrease: /* @__PURE__ */ __name(({
          runtime: current,
          nextMaterialization,
          decision
        }) => {
          if (current.trusted && !decision.targetTrusted) return true;
          if (!current.primary || !current.trusted) return false;
          try {
            const previous = JSON.parse(
              current.trustMaterialization ?? "{}"
            );
            const next = JSON.parse(nextMaterialization);
            if (!Array.isArray(previous.boundWorkspaces) || !Array.isArray(next.boundWorkspaces)) {
              return true;
            }
            const nextRoots = new Set(
              next.boundWorkspaces.filter(
                (value) => typeof value === "string"
              )
            );
            return previous.boundWorkspaces.some(
              (value) => typeof value !== "string" || !nextRoots.has(value)
            );
          } catch {
            return true;
          }
        }, "isTrustDecrease"),
        buildRuntime: /* @__PURE__ */ __name(async ({
          entry,
          trusted,
          snapshot,
          decision,
          generationGuard
        }) => {
          const materialized = materializationFor(
            entry,
            snapshot,
            trusted === decision.targetTrusted ? decision : { ...decision, targetTrusted: trusted }
          );
          return createDynamicWorkspaceRuntime(entry.workspaceCwd, {
            trusted,
            snapshot,
            decision,
            generationGuard,
            primary: entry.primary,
            removable: entry.removable,
            displayName: entry.displayName,
            registrationIds: entry.registrationIds,
            boundWorkspaces: materialized.boundWorkspaces,
            trustMaterialization: materialized.key
          });
        }, "buildRuntime"),
        drainRuntime: /* @__PURE__ */ __name(async (runtimeToDrain) => {
          workspaceRuntimeRemoval.beginDrain(runtimeToDrain);
          acpHandle()?.beginWorkspaceDrain(runtimeToDrain.workspaceId);
        }, "drainRuntime"),
        disposeRuntime: /* @__PURE__ */ __name(async (runtimeToDispose, reason) => {
          const errors = [];
          try {
            await workspaceRuntimeRemoval.disposeRuntime(
              runtimeToDispose,
              reason
            );
          } catch (error) {
            errors.push(error);
          }
          try {
            const handle = acpHandle();
            if (!runtimeToDispose.primary) {
              handle?.commitWorkspaceRemoval(runtimeToDispose.workspaceId);
            }
            handle?.disposeWorkspace(runtimeToDispose.workspaceId);
            const deadline = Date.now() + 1e3;
            while ((handle?.getWorkspaceActivity(runtimeToDispose.workspaceId).memoryTasks ?? 0) > 0 && Date.now() < deadline) {
              await new Promise((resolve3) => setTimeout(resolve3, 25));
            }
            if ((handle?.getWorkspaceActivity(runtimeToDispose.workspaceId).memoryTasks ?? 0) > 0) {
              throw new Error(
                "Workspace memory tasks did not stop after runtime disposal."
              );
            }
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) {
            throw new AggregateError(
              errors,
              "Workspace runtime and ACP cleanup failed."
            );
          }
        }, "disposeRuntime"),
        runtimeActivated: /* @__PURE__ */ __name(async (runtimeAdded) => {
          workspaceRuntimeRemoval.cancelDrain(runtimeAdded);
          acpHandle()?.cancelWorkspaceDrain(runtimeAdded.workspaceId);
          if (runtimeAdded.primary) {
            bridgeRef = runtimeAdded.bridge;
            invalidatePrimaryServeFeaturesCache();
          }
          await workspaceRuntimeRemoval.runtimeAdded(runtimeAdded);
        }, "runtimeActivated"),
        onError: /* @__PURE__ */ __name((entry, error) => {
          daemonLog.error(
            `workspace trust reconciliation failed for ${entry.workspaceCwd}`,
            error instanceof Error ? error : null
          );
        }, "onError")
      });
      const trustMonitor = createDaemonTrustPolicyMonitor({
        onSnapshot: /* @__PURE__ */ __name((snapshot) => {
          latestTrustPolicySnapshot = snapshot;
          return runWorkspaceTrustOperation(
            () => trustReconciler.reconcile(snapshot)
          );
        }, "onSnapshot"),
        onError: /* @__PURE__ */ __name((error) => {
          daemonLog.error(
            "workspace trust policy monitor failed",
            error instanceof Error ? error : null
          );
        }, "onError")
      });
      app2.locals.stopTrustPolicyMonitor = () => trustMonitor.stop();
      app2.locals.requestTrustReconcile = () => trustMonitor.requestReconcile("manual");
      app2.locals.waitForTrustPolicyIdle = () => runWorkspaceTrustOperation(async () => void 0);
      await trustMonitor.start();
    }
    const activePrimaryBridge = workspaceRegistry.primaryEntry.current?.runtime.bridge;
    bridgeRef = activePrimaryBridge;
    return { app: app2, bridge: activePrimaryBridge };
  }, "buildRuntime");
  if (deps.bridge) {
    const runtime = await buildRuntime();
    runtimeAppForCleanup = runtime.app;
    bridgeRef = runtime.bridge;
    if (!opts.channelSelection) {
      runtimeApp = runtime.app;
      runtimeStartupSettled = true;
      markRuntimeReady();
    }
  }
  cliVersion ??= await cliVersionPromise;
  const bootstrapApp = createBootstrapServeApp({
    opts,
    getPort: /* @__PURE__ */ __name(() => actualPort, "getPort"),
    boundWorkspace,
    startup,
    daemonLog,
    qwenCodeVersion: cliVersion,
    sessionShellCommandEnabled,
    sessionArtifactsPersistenceAvailable,
    workspaceRuntimeAvailable: deps.bridge === void 0 || typeof deps.bridge.getWorkspaceRuntimeLifecycleSnapshot === "function",
    currentSessionSchedulingAvailable: false,
    permissionPolicy,
    multiWorkspaceCapabilitiesRequireRuntime: workspaceInputs.length > 1,
    getRuntimeError: /* @__PURE__ */ __name(() => runtimeStartupError, "getRuntimeError"),
    getChannelWorkerSnapshot,
    getChannelWorkerSnapshots,
    onHealthServed: deferRuntimeUntilFirstHealth ? () => startRuntimeAfterHealth?.() : void 0
  });
  const deferredChannelWebhookAuth = deferRuntimeUntilFirstHealth ? createDeferredChannelWebhookAuth(
    resolveChannelWebhookConfigSource,
    await loadChannelWebhookConfigRuntime(),
    daemonLog
  ) : void 0;
  const app = runtimeApp ?? createDelegatingServeApp(bootstrapApp, () => runtimeApp, {
    waitForDeferredRuntimeRoutes: deferRuntimeUntilFirstHealth,
    startRuntime: /* @__PURE__ */ __name(() => startRuntimeForRequest?.() ?? false, "startRuntime"),
    runtimeReady,
    authenticateDeferredRuntimeRequest: bearerAuth(opts.token),
    authenticateDeferredChannelWebhookRequest: deferredChannelWebhookAuth,
    // The runtime app serves these before bearerAuth; a browser navigation
    // cannot attach the bearer header, so the cold gate must let them
    // through (and start the runtime) exactly like the warm app would.
    // Dynamic import keeps web-shell-static out of the serve fast-path
    // static closure (see the import-boundary guards in fast-path.test.ts).
    isPreAuthRequest: webShellMounted ? (req) => import("./web-shell-static-RIRXRMXU.js").then(
      (webShellStatic) => webShellStatic.isPreAuthWebShellRequest(req)
    ) : void 0
  });
  let listenHostname = opts.hostname;
  if (opts.hostname.startsWith("[")) {
    const inner = opts.hostname.slice(1, -1);
    if (!opts.hostname.endsWith("]") || inner.length === 0 || inner.includes("]")) {
      throw new Error(
        `Invalid --hostname "${opts.hostname}": brackets indicate an IPv6 literal but the value isn't a clean [addr] form. Pass the address without a trailing :port (use --port for that), e.g. "--hostname [::1] --port 4170".`
      );
    }
    listenHostname = inner;
  }
  if (opts.maxConnections !== void 0 && (Number.isNaN(opts.maxConnections) || opts.maxConnections < 0)) {
    throw new TypeError(
      `Invalid maxConnections: ${opts.maxConnections}. Must be >= 0 (0 / Infinity = unlimited).`
    );
  }
  let channelValidationSettingsRuntime;
  let channelValidationTrustPolicy;
  let channelValidationTrustSnapshot;
  const resolveChannelWorkspaceGroupsAtListen = /* @__PURE__ */ __name(() => {
    const validationSettingsRuntime = channelValidationSettingsRuntime;
    if (!opts.channelSelection || !validationSettingsRuntime || !channelRuntime) {
      return void 0;
    }
    const registry = (runtimeApp ?? runtimeAppForCleanup)?.locals?.["workspaceRegistry"];
    const resolveRuntime = /* @__PURE__ */ __name((workspaceCwd) => {
      const runtime = registry?.getByWorkspaceCwd(workspaceCwd);
      if (registry && !runtime) {
        throw Object.assign(
          new Error(`Workspace "${workspaceCwd}" is unavailable.`),
          { code: "workspace_unavailable" }
        );
      }
      return runtime;
    }, "resolveRuntime");
    const resolveTrusted = /* @__PURE__ */ __name((workspaceCwd, primary, runtime) => {
      if (runtime) return runtime.trusted;
      if (primary && deps.trustedWorkspace !== void 0) {
        return deps.trustedWorkspace;
      }
      if (!channelValidationTrustPolicy || !channelValidationTrustSnapshot) {
        return false;
      }
      return channelValidationTrustPolicy.evaluateDaemonWorkspaceTrust(
        channelValidationTrustSnapshot,
        workspaceCwd
      ).targetTrusted;
    }, "resolveTrusted");
    const settingsByWorkspace = /* @__PURE__ */ new Map();
    if (workspaceInputs.length === 1) {
      const workspace = workspaceInputs[0];
      const runtime = resolveRuntime(workspace.cwd);
      const trusted = resolveTrusted(workspace.cwd, true, runtime);
      if (!trusted) {
        throw Object.assign(
          new Error(
            `Primary workspace "${workspace.cwd}" is not trusted; cannot host channels.`
          ),
          { code: "untrusted_workspace" }
        );
      }
      const effectiveEnv = runtime ? workspaceRuntimeEffectiveEnv(runtime, daemonRuntimeBaseEnv) : validationSettingsRuntime.environment.buildRuntimeEnvironment(
        validationSettingsRuntime.settings.loadSettings(workspace.cwd, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: false,
          workspaceTrusted: true
        }).merged,
        workspace.cwd,
        daemonRuntimeBaseEnv,
        trusted
      ).effectiveEnv;
      channelWebhookEnvByWorkspace.set(workspace.cwd, effectiveEnv);
      return void 0;
    }
    const workspaces = workspaceInputs.map((workspace, index) => {
      const runtime = resolveRuntime(workspace.cwd);
      const trusted = resolveTrusted(workspace.cwd, index === 0, runtime);
      const settings = validationSettingsRuntime.settings.loadSettings(
        workspace.cwd,
        {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: !trusted,
          workspaceTrusted: trusted
        }
      );
      settingsByWorkspace.set(workspace.cwd, settings);
      channelWebhookEnvByWorkspace.set(
        workspace.cwd,
        runtime ? workspaceRuntimeEffectiveEnv(runtime, daemonRuntimeBaseEnv) : validationSettingsRuntime.environment.buildRuntimeEnvironment(
          settings.merged,
          workspace.cwd,
          daemonRuntimeBaseEnv,
          trusted
        ).effectiveEnv
      );
      return {
        workspaceCwd: workspace.cwd,
        primary: runtime?.primary ?? index === 0,
        trusted
      };
    });
    const grouping = resolveChannelWorkspaceGroups({
      workspaces,
      selection: opts.channelSelection,
      loadChannelsConfig: /* @__PURE__ */ __name((cwd) => {
        const settings = settingsByWorkspace.get(cwd);
        if (!settings) return {};
        return channelRuntime.loadChannelsConfig(cwd, settings);
      }, "loadChannelsConfig")
    });
    if (!grouping.ok) {
      throw Object.assign(new Error(grouping.error.message), {
        code: grouping.error.code,
        ...grouping.error.channel ? { channel: grouping.error.channel } : {}
      });
    }
    return grouping.groups;
  }, "resolveChannelWorkspaceGroupsAtListen");
  if (opts.channelSelection) {
    try {
      channelValidationSettingsRuntime = await loadSettingsRuntimeModules();
      channelValidationTrustPolicy = await import("./daemon-trust-policy-IL7XNHXQ.js");
      channelValidationTrustSnapshot = await channelValidationTrustPolicy.readDaemonTrustPolicySnapshot();
      if (opts.channelSelection.mode === "names" && workspaceInputs.length > MAX_CHANNEL_CONTROL_WORKSPACES) {
        const groups = resolveChannelWorkspaceGroupsAtListen();
        assertChannelControlWorkspaceCapacity(
          groups?.map((group) => group.workspaceCwd) ?? []
        );
      }
      reserveChannelServicePidfile(opts.channelSelection);
    } catch (error) {
      if (!channelSelectionFromSettings) throw error;
      removeCurrentServePidfile();
      opts.channelSelection = void 0;
      reportConfiguredChannelStartupFailure(error);
    }
  }
  return await new Promise((resolve3, reject) => {
    let closeHost;
    const onListening = /* @__PURE__ */ __name((error) => {
      if (error) return;
      startup.listenerReadyAt = (/* @__PURE__ */ new Date()).toISOString();
      startup.processToListenMs = Math.round(process.uptime() * 1e3);
      startup.runQwenServeToListenMs = Math.round(
        performance2.now() - runStartedAt
      );
      profileCheckpoint("serve_listener_ready");
      finalizeStartupProfile(`serve-${process.pid}`);
      const cap = opts.maxConnections ?? 256;
      if (cap > 0 && Number.isFinite(cap)) {
        server.maxConnections = cap;
      }
      const addr = server.address();
      actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
      const scheme = tlsOptions ? "https" : "http";
      const url = `${scheme}://${formatHostForUrl(optsIn.hostname)}:${actualPort}`;
      const liveRuntimeBaseDir = path.dirname(daemonLogBaseDir);
      const liveDiscoveryOwners = [];
      const rememberLiveDiscoveryOwner = /* @__PURE__ */ __name((owner) => {
        if (liveDiscoveryOwners.some(
          (candidate) => candidate.runtimeBaseDir === owner.runtimeBaseDir && candidate.instanceNonce === owner.instanceNonce && candidate.pid === owner.pid
        )) {
          return;
        }
        liveDiscoveryOwners.push(owner);
      }, "rememberLiveDiscoveryOwner");
      let liveDiscoveryPublish;
      let liveDiscoveryRetryTimer;
      let liveDiscoveryRetryTask;
      let liveDiscoveryBootRetryApp;
      let liveDiscoveryEnabled = false;
      let liveDiscoveryShuttingDown = false;
      let liveDiscoveryToggle = Promise.resolve();
      let attemptPendingLiveDiscovery;
      const pendingLiveDiscoveryBaseDirs = /* @__PURE__ */ new Set();
      const warnedLiveDiscoveryOwners = /* @__PURE__ */ new Set();
      let warnedLiveDiscoveryBootFailure = false;
      const liveDiscoveryRetryDelayMs = deps.liveDiscoveryRetryDelayMs !== void 0 && Number.isFinite(deps.liveDiscoveryRetryDelayMs) && deps.liveDiscoveryRetryDelayMs >= 10 ? Math.min(deps.liveDiscoveryRetryDelayMs, 6e4) : DEFAULT_LIVE_DISCOVERY_RETRY_MS;
      const scheduleLiveDiscoveryRetry = /* @__PURE__ */ __name(() => {
        if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled || liveDiscoveryRetryTimer || liveDiscoveryRetryTask || !liveDiscoveryBootRetryApp && (pendingLiveDiscoveryBaseDirs.size === 0 || !attemptPendingLiveDiscovery)) {
          return;
        }
        liveDiscoveryRetryTimer = setTimeout(() => {
          liveDiscoveryRetryTimer = void 0;
          if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) {
            return;
          }
          const retryApp = liveDiscoveryBootRetryApp;
          liveDiscoveryBootRetryApp = void 0;
          const retryOperation = retryApp ? publishLiveDiscovery(retryApp) : attemptPendingLiveDiscovery?.();
          if (!retryOperation) return;
          const retry = retryOperation.finally(() => {
            if (liveDiscoveryRetryTask === retry) {
              liveDiscoveryRetryTask = void 0;
            }
            scheduleLiveDiscoveryRetry();
          });
          liveDiscoveryRetryTask = retry;
        }, liveDiscoveryRetryDelayMs);
        liveDiscoveryRetryTimer.unref();
      }, "scheduleLiveDiscoveryRetry");
      const cancelLiveDiscoveryRetry = /* @__PURE__ */ __name(() => {
        if (!liveDiscoveryRetryTimer) return;
        clearTimeout(liveDiscoveryRetryTimer);
        liveDiscoveryRetryTimer = void 0;
      }, "cancelLiveDiscoveryRetry");
      const publishLiveDiscovery = /* @__PURE__ */ __name((candidateApp) => {
        if (liveDiscoveryShuttingDown) return Promise.resolve();
        if (!resolveAcpHttpEnabled()) return Promise.resolve();
        if (candidateApp.locals?.["liveVoiceEnabled"] !== true)
          return Promise.resolve();
        liveDiscoveryEnabled = true;
        if (liveDiscoveryPublish) return liveDiscoveryPublish;
        const coordinator = candidateApp.locals?.["liveCoordinator"];
        const instanceNonce = coordinator?.daemonInstanceNonce;
        if (typeof instanceNonce !== "string") return Promise.resolve();
        let publicationFailed = false;
        let publicationRetryable = false;
        const publication = serveAppLifecycle.startBoot().then(() => loadLiveDiscoveryRuntime()).then(
          async ({
            handoffLiveDiscoveryOwner,
            LiveDiscoveryOwnerActiveError,
            LiveDiscoveryPublicationError,
            removeLiveDiscoveryFile,
            writeLiveDiscoveryFile
          }) => {
            if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) return;
            liveDiscoveryBootRetryApp = void 0;
            warnedLiveDiscoveryBootFailure = false;
            const stableBaseDir = liveDiscoveryStableBaseDir;
            const runtimeBaseDir = path.resolve(liveRuntimeBaseDir);
            const targetBaseDirs = /* @__PURE__ */ new Set();
            if (runtimeBaseDir !== stableBaseDir) {
              targetBaseDirs.add(runtimeBaseDir);
            }
            targetBaseDirs.add(stableBaseDir);
            for (const baseDir of targetBaseDirs) {
              pendingLiveDiscoveryBaseDirs.add(baseDir);
            }
            const record = {
              url,
              ...token ? { token } : {},
              protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
              pid: process.pid,
              instanceNonce
            };
            attemptPendingLiveDiscovery = /* @__PURE__ */ __name(async () => {
              const targets = [...pendingLiveDiscoveryBaseDirs];
              const published = [];
              const rollbackPublished = /* @__PURE__ */ __name(async () => {
                for (const owner of published.splice(0)) {
                  try {
                    await removeLiveDiscoveryFile(
                      owner.runtimeBaseDir,
                      owner
                    );
                  } catch (cleanupError) {
                    rememberLiveDiscoveryOwner(owner);
                    daemonLog.warn(
                      `failed to roll back Live Host discovery at ${owner.runtimeBaseDir}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
                    );
                  }
                }
              }, "rollbackPublished");
              for (const runtimeBaseDir2 of targets) {
                if (liveDiscoveryShuttingDown || !liveDiscoveryEnabled) {
                  await rollbackPublished();
                  return;
                }
                try {
                  await handoffLiveDiscoveryOwner(
                    runtimeBaseDir2,
                    record,
                    async () => void 0
                  );
                  await writeLiveDiscoveryFile(runtimeBaseDir2, record);
                  published.push({
                    runtimeBaseDir: runtimeBaseDir2,
                    instanceNonce,
                    pid: process.pid
                  });
                } catch (err) {
                  if (err instanceof LiveDiscoveryPublicationError && err.published) {
                    published.push({
                      runtimeBaseDir: runtimeBaseDir2,
                      instanceNonce,
                      pid: process.pid
                    });
                  }
                  await rollbackPublished();
                  if (err instanceof LiveDiscoveryOwnerActiveError) {
                    if (!warnedLiveDiscoveryOwners.has(runtimeBaseDir2)) {
                      warnedLiveDiscoveryOwners.add(runtimeBaseDir2);
                      daemonLog.warn(
                        `failed to publish Live Host discovery at ${runtimeBaseDir2}: ${err.message}`
                      );
                    }
                    return;
                  }
                  daemonLog.warn(
                    `failed to publish Live Host discovery at ${runtimeBaseDir2}: ${err instanceof Error ? err.message : String(err)}`
                  );
                  return;
                }
              }
              for (const owner of published) {
                pendingLiveDiscoveryBaseDirs.delete(owner.runtimeBaseDir);
                warnedLiveDiscoveryOwners.delete(owner.runtimeBaseDir);
                rememberLiveDiscoveryOwner(owner);
              }
            }, "attemptPendingLiveDiscovery");
            await attemptPendingLiveDiscovery();
            scheduleLiveDiscoveryRetry();
          }
        ).catch((err) => {
          publicationFailed = true;
          publicationRetryable = err instanceof ConversationRuntimeOwnershipError && err.retryable;
          if (!publicationRetryable || !warnedLiveDiscoveryBootFailure) {
            warnedLiveDiscoveryBootFailure = publicationRetryable;
            daemonLog.warn(
              `failed to publish Live Host discovery: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
        const trackedPublication = publication.finally(() => {
          if (publicationFailed && liveDiscoveryPublish === trackedPublication) {
            liveDiscoveryPublish = void 0;
            if (publicationRetryable && !liveDiscoveryShuttingDown && liveDiscoveryEnabled) {
              liveDiscoveryBootRetryApp = candidateApp;
              scheduleLiveDiscoveryRetry();
            }
          }
        });
        liveDiscoveryPublish = trackedPublication;
        return liveDiscoveryPublish;
      }, "publishLiveDiscovery");
      const removeLiveDiscoveryOwners = /* @__PURE__ */ __name(async () => {
        const owners = [...liveDiscoveryOwners];
        if (owners.length === 0) return;
        let removeLiveDiscoveryFile;
        try {
          ({ removeLiveDiscoveryFile } = await loadLiveDiscoveryRuntime());
        } catch (err) {
          throw new Error("Failed to load Live discovery cleanup support.", {
            cause: err
          });
        }
        const errors = [];
        for (const owner of owners) {
          try {
            await removeLiveDiscoveryFile(owner.runtimeBaseDir, owner);
            const index = liveDiscoveryOwners.indexOf(owner);
            if (index >= 0) liveDiscoveryOwners.splice(index, 1);
          } catch (err) {
            errors.push(err);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "Live Host discovery cleanup is incomplete."
          );
        }
      }, "removeLiveDiscoveryOwners");
      const unpublishLiveDiscovery = /* @__PURE__ */ __name(async () => {
        liveDiscoveryEnabled = false;
        liveDiscoveryBootRetryApp = void 0;
        warnedLiveDiscoveryBootFailure = false;
        cancelLiveDiscoveryRetry();
        pendingLiveDiscoveryBaseDirs.clear();
        attemptPendingLiveDiscovery = void 0;
        await liveDiscoveryPublish;
        await liveDiscoveryRetryTask;
        liveDiscoveryPublish = void 0;
        liveDiscoveryRetryTask = void 0;
        await removeLiveDiscoveryOwners();
      }, "unpublishLiveDiscovery");
      const attachLiveDiscoveryControl = /* @__PURE__ */ __name((candidateApp) => {
        candidateApp.locals.setLiveDiscoveryEnabled = (enabled) => {
          const operation = liveDiscoveryToggle.then(
            () => enabled ? publishLiveDiscovery(candidateApp) : unpublishLiveDiscovery()
          );
          liveDiscoveryToggle = operation.catch(() => void 0);
          return operation;
        };
        candidateApp.locals.onConversationRuntimeReady = () => {
          void publishLiveDiscovery(candidateApp);
        };
      }, "attachLiveDiscoveryControl");
      const cleanupLiveDiscovery = /* @__PURE__ */ __name(async () => {
        liveDiscoveryShuttingDown = true;
        cancelLiveDiscoveryRetry();
        await liveDiscoveryToggle;
        await unpublishLiveDiscovery();
      }, "cleanupLiveDiscovery");
      let shuttingDown = false;
      let closePromise;
      let runtimeStartupTimer;
      let runtimeStartAfterHealthTimer;
      let runtimeStartFallbackTimer;
      const runtimeStartupTimeoutMs = resolveRuntimeStartupTimeoutMs(
        deps.runtimeStartupTimeoutMs
      );
      const clearRuntimeStartupTimer = /* @__PURE__ */ __name(() => {
        if (!runtimeStartupTimer) return;
        clearTimeout(runtimeStartupTimer);
        runtimeStartupTimer = void 0;
      }, "clearRuntimeStartupTimer");
      const clearRuntimeStartFallbackTimer = /* @__PURE__ */ __name(() => {
        if (!runtimeStartFallbackTimer) return;
        clearTimeout(runtimeStartFallbackTimer);
        runtimeStartFallbackTimer = void 0;
      }, "clearRuntimeStartFallbackTimer");
      const clearRuntimeStartAfterHealthTimer = /* @__PURE__ */ __name(() => {
        if (!runtimeStartAfterHealthTimer) return;
        clearTimeout(runtimeStartAfterHealthTimer);
        runtimeStartAfterHealthTimer = void 0;
      }, "clearRuntimeStartAfterHealthTimer");
      const cancelDeferredRuntimeStartup = /* @__PURE__ */ __name(() => {
        if (!deferRuntimeUntilFirstHealth || runtimeStarting || runtimeStartupSettled)
          return;
        daemonLog.info(
          "deferred runtime: cancelled, server closed before startup"
        );
        runtimeStartupSettled = true;
        const error2 = new Error(RUNTIME_STARTUP_CANCELLED_MESSAGE);
        runtimeStartupError = error2.message;
        markRuntimeFailed(error2);
      }, "cancelDeferredRuntimeStartup");
      const shutdownBridgeAfterFailedStartup = /* @__PURE__ */ __name(async (bridge) => {
        if (!bridge || deps.bridge) return;
        if (shutdownBridges.has(bridge)) return;
        shutdownBridges.add(bridge);
        try {
          await bridge.shutdown();
        } catch (shutdownErr) {
          daemonLog.error(
            "bridge shutdown after runtime startup error failed",
            shutdownErr instanceof Error ? shutdownErr : null
          );
        } finally {
          if (bridgeRef === bridge) {
            bridgeRef = void 0;
          }
        }
      }, "shutdownBridgeAfterFailedStartup");
      const stopChannelWorkerAfterFailedStartup = /* @__PURE__ */ __name(async () => {
        if (!channelWorkerManager) return true;
        try {
          await channelWorkerManager.shutdown();
          return true;
        } catch (stopErr) {
          daemonLog.error(
            "channel worker stop after runtime startup error failed",
            stopErr instanceof Error ? stopErr : null
          );
          return false;
        }
      }, "stopChannelWorkerAfterFailedStartup");
      const failRuntimeStartup = /* @__PURE__ */ __name(async (err, bridgeForCleanup) => {
        const error2 = err instanceof Error ? err : new Error(String(err));
        markServeAppStartupFailed(error2);
        if (runtimeStartupSettled) {
          disposeRuntimeAppResources(runtimeApp ?? runtimeAppForCleanup);
          await shutdownBridgeAfterFailedStartup(bridgeForCleanup);
          return;
        }
        runtimeStartupSettled = true;
        disposeRuntimeAppResources(runtimeApp ?? runtimeAppForCleanup);
        runtimeApp = void 0;
        clearRuntimeStartupTimer();
        const message = error2.message;
        runtimeStartupError = message;
        if (startup.preheat.status === "scheduled" || startup.preheat.status === "running") {
          startup.preheat.status = "failed";
          startup.preheat.error = message;
        }
        writeStderrLine(`qwen serve: runtime startup failed: ${message}`);
        daemonLog.error("runtime startup failed", error2);
        markRuntimeFailed(error2);
        if (closeServerAfterChannelWorkerStartupFailure && server.listening) {
          server.close((closeErr) => {
            if (closeErr) {
              daemonLog.error(
                "server close after runtime startup error failed",
                closeErr
              );
            }
          });
          server.closeAllConnections();
        }
        const channelWorkerStopped = await stopChannelWorkerAfterFailedStartup();
        disposeDaemonEventLoopMonitor();
        if (channelWorkerStopped) removeCurrentServePidfile();
        const bridgesForCleanup = bridgeForCleanup ? [bridgeForCleanup, ...getRuntimeBridgesForCleanup()] : getRuntimeBridgesForCleanup();
        for (const bridge of [...new Set(bridgesForCleanup)]) {
          await shutdownBridgeAfterFailedStartup(bridge);
        }
      }, "failRuntimeStartup");
      const armRuntimeStartupTimer = /* @__PURE__ */ __name(() => {
        if (runtimeStartupTimeoutMs <= 0 || runtimeStartupTimer) return;
        runtimeStartupTimer = setTimeout(() => {
          const timeoutError = new Error(
            `Daemon runtime startup timed out after ${runtimeStartupTimeoutMs}ms.`
          );
          void failRuntimeStartup(timeoutError);
        }, runtimeStartupTimeoutMs);
        runtimeStartupTimer.unref();
      }, "armRuntimeStartupTimer");
      const resolveRuntimeChannelGroups = /* @__PURE__ */ __name(async (channelSelection, candidateApp, operation) => {
        const registry = candidateApp.locals?.["workspaceRegistry"];
        if (!registry) {
          throw new Error(
            "Workspace registry is not available for channel workers."
          );
        }
        const runtimes = registry.list().filter((runtime) => runtime.provenance !== "live-conversation");
        if (runtimes.length <= 1 && operation === "initial") {
          const primary = registry.primary;
          if (!primary.trusted) {
            throw Object.assign(
              new Error(
                `Primary workspace "${primary.workspaceCwd}" is not trusted; cannot host channels.`
              ),
              { code: "untrusted_workspace" }
            );
          }
          return [
            {
              workspaceCwd: primary.workspaceCwd,
              selection: channelSelection
            }
          ];
        }
        const workerRuntime = await ensureChannelRuntime();
        const settingsRuntime = await loadSettingsRuntimeModules();
        const settingsByWorkspace = /* @__PURE__ */ new Map();
        const grouping = resolveChannelWorkspaceGroups({
          workspaces: runtimes.map((runtime) => {
            const settings = settingsRuntime.settings.loadSettings(
              runtime.workspaceCwd,
              {
                skipLoadEnvironment: true,
                skipWorkspaceSettings: !runtime.trusted,
                workspaceTrusted: runtime.trusted
              }
            );
            settingsByWorkspace.set(runtime.workspaceCwd, settings);
            return {
              workspaceCwd: runtime.workspaceCwd,
              primary: runtime.primary,
              trusted: runtime.trusted,
              provenance: runtime.provenance
            };
          }),
          selection: channelSelection,
          loadChannelsConfig: /* @__PURE__ */ __name((cwd) => {
            const settings = settingsByWorkspace.get(cwd);
            return settings ? workerRuntime.loadChannelsConfig(cwd, settings) : {};
          }, "loadChannelsConfig")
        });
        if (!grouping.ok) {
          throw Object.assign(new Error(grouping.error.message), {
            code: grouping.error.code,
            ...grouping.error.channel ? { channel: grouping.error.channel } : {}
          });
        }
        return grouping.groups;
      }, "resolveRuntimeChannelGroups");
      ensureChannelWorkerManager = /* @__PURE__ */ __name(() => {
        if (channelWorkerManager) return Promise.resolve(channelWorkerManager);
        if (channelWorkerManagerStarting) return channelWorkerManagerStarting;
        const starting = (async () => {
          const candidateApp = runtimeApp ?? runtimeAppForCleanup;
          const registry = candidateApp?.locals?.["workspaceRegistry"];
          if (!candidateApp || !registry) {
            throw new Error(
              "Workspace registry is not available for channels."
            );
          }
          const workerRuntime = await ensureChannelRuntime();
          const workerHostname = tlsOptions ? optsIn.hostname : opts.hostname;
          const workerDaemonUrl = formatChannelWorkerDaemonUrl(
            workerHostname,
            actualPort,
            tlsOptions !== void 0
          );
          (deps.channelWorkerUrlCertifier ?? assertChannelWorkerDaemonUrlIsLocal)(workerDaemonUrl, workerHostname);
          if (tlsOptions && tlsCertPath && process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") {
            daemonLog.warn(
              `NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification for channel workers; skipping the worker TLS trust check.`
            );
          } else if (tlsOptions && tlsCertPath) {
            const operatorCaCertPath = process.env["NODE_EXTRA_CA_CERTS"];
            let operatorCaCert;
            let operatorCaCertReadError;
            if (operatorCaCertPath) {
              try {
                operatorCaCert = fs.readFileSync(operatorCaCertPath);
              } catch (error2) {
                operatorCaCertReadError = error2?.code ?? "read failed";
              }
            }
            let predictedGaps = [];
            try {
              predictedGaps = describeWorkerTlsTrustGaps({
                cert: tlsOptions.cert,
                certPath: tlsCertPath,
                certSourcePath: tlsCertPath,
                daemonUrl: workerDaemonUrl,
                ...operatorCaCertPath ? { operatorCaCertPath } : {},
                ...operatorCaCert ? {
                  operatorCaCert,
                  operatorCaCertSourcePath: operatorCaCertPath
                } : {},
                ...operatorCaCertReadError ? { operatorCaCertReadError } : {}
              });
            } catch (error2) {
              if (!(error2 instanceof ExtraCaInspectionError)) throw error2;
              daemonLog.warn(
                `Channel worker TLS trust-gap inspection could not run: ${error2.message} Continuing with the live handshake probe only.`
              );
            }
            const workerCaCertPath = workerRuntime.resolveWorkerCaCertPath(
              tlsCertPath,
              operatorCaCertPath
            );
            const trustFailure = await (deps.workerTlsTrustVerifier ?? verifyWorkerTlsTrust)({
              daemonUrl: workerDaemonUrl,
              caCertPath: workerCaCertPath
            });
            if (shuttingDown || runtimeStartupError !== void 0) {
              throw new Error(
                "Daemon stopped while the channel worker TLS trust check was running."
              );
            }
            if (trustFailure) {
              if (predictedGaps.length > 0) {
                for (const gap of predictedGaps) daemonLog.warn(gap);
              } else {
                daemonLog.warn(
                  `Channel worker TLS verification failed against the exact CA bundle workers receive (${sanitizeLogText(normalizeWorkerDiagnostic(trustFailure.code), 80)}): ${sanitizeLogText(normalizeWorkerDiagnostic(trustFailure.message), 300)}`
                );
              }
            }
          }
          const createSupervisor = deps.channelWorkerSupervisorFactory ?? workerRuntime.createChannelWorkerSupervisor;
          const createGroup = /* @__PURE__ */ __name((groups) => workerRuntime.createChannelWorkerGroup({
            groups,
            registry,
            createSupervisor,
            shared: {
              cliEntryPath: workerRuntime.findCliEntryPath(),
              daemonUrl: workerDaemonUrl,
              ...token ? { daemonToken: token } : {},
              ...tlsCertPath ? { workerTlsCaCertPath: tlsCertPath } : {}
            },
            onReady: /* @__PURE__ */ __name((snapshot) => {
              if (runtimeStartupError !== void 0) return;
              if (workspaceInputs.length > 1) {
                daemonLog.info("channel worker ready", {
                  workspace: snapshot.workspaceCwd,
                  pid: snapshot.pid,
                  channels: snapshot.channels
                });
              }
              channelWorkerManager?.workerChanged();
              if (!runtimeStartupSettled) writeChannelWorkerPidfile();
            }, "onReady"),
            onExit: /* @__PURE__ */ __name((snapshot) => {
              const workspacePrefix = workspaceInputs.length > 1 ? `workspace=${snapshot.workspaceCwd}, ` : "";
              daemonLog.warn(
                `channel worker exited (${workspacePrefix}state=${snapshot.state}, pid=${snapshot.pid ?? "unknown"}, code=${snapshot.exitCode ?? "null"}, signal=${snapshot.signal ?? "null"}, error=${snapshot.error ?? "none"}, restartCount=${snapshot.restartCount ?? 0}, nextRestartAt=${snapshot.nextRestartAt ?? "none"}, staleHeartbeatAt=${snapshot.staleHeartbeatAt ?? "none"})`
              );
              channelWorkerManager?.workerChanged();
              if (!runtimeStartupSettled) writeChannelWorkerPidfile();
            }, "onExit"),
            onStateChange: /* @__PURE__ */ __name(() => {
              channelWorkerManager?.workerChanged();
              if (!runtimeStartupSettled) writeChannelWorkerPidfile();
            }, "onStateChange"),
            onLog: /* @__PURE__ */ __name(({ stream, line, workspaceCwd }) => {
              const message = workspaceInputs.length > 1 ? `channel worker [${workspaceCwd}] ${stream}: ${line}` : `channel worker ${stream}: ${line}`;
              if (stream === "stderr") daemonLog.warn(message);
              else daemonLog.info(message);
            }, "onLog")
          }), "createGroup");
          channelWorkerManager = workerRuntime.createChannelWorkerManager({
            resolveGroups: /* @__PURE__ */ __name((selection, operation) => resolveRuntimeChannelGroups(selection, candidateApp, operation), "resolveGroups"),
            createGroup,
            reserveLease: reserveChannelServicePidfile,
            releaseLease: /* @__PURE__ */ __name(() => {
              removeCurrentServePidfile();
              if (channelPidfileReserved) {
                throw new Error("Failed to release the channel service lease.");
              }
            }, "releaseLease"),
            initialLeaseReserved: channelPidfileReserved,
            onCommittedSelection: /* @__PURE__ */ __name((_selection, groups) => {
              channelWorkspaceGroups = groups;
              channelWebhookConfigVersion += 1;
              refreshChannelWebhookConfigs?.();
            }, "onCommittedSelection"),
            onStateChange: /* @__PURE__ */ __name(() => {
              if (runtimeStartupSettled) writeChannelWorkerPidfile();
            }, "onStateChange")
          });
          return channelWorkerManager;
        })();
        channelWorkerManagerStarting = starting;
        void starting.then(
          () => {
            if (channelWorkerManagerStarting === starting) {
              channelWorkerManagerStarting = void 0;
            }
          },
          () => {
            if (channelWorkerManagerStarting === starting) {
              channelWorkerManagerStarting = void 0;
            }
          }
        );
        return starting;
      }, "ensureChannelWorkerManager");
      const completeRuntimeStartup = /* @__PURE__ */ __name(async (candidateApp) => {
        if (runtimeStartupSettled) return;
        runtimeApp = candidateApp;
        attachLiveDiscoveryControl(candidateApp);
        const acpHandle = candidateApp.locals?.["acpHandle"];
        acpHandle?.attachServer?.(server);
        if (opts.channelSelection) {
          closeServerAfterChannelWorkerStartupFailure = true;
          let manager;
          try {
            manager = await ensureChannelWorkerManager();
            await manager.startInitial(opts.channelSelection);
          } catch (error2) {
            if (!channelSelectionFromSettings || runtimeStartupSettled) {
              throw error2;
            }
            closeServerAfterChannelWorkerStartupFailure = false;
            opts.channelSelection = void 0;
            reportConfiguredChannelStartupFailure(error2);
            try {
              if (manager) {
                await manager.stopSelection();
              } else {
                removeCurrentServePidfile();
                if (channelPidfileReserved) {
                  throw new Error(
                    "Failed to release the channel service lease."
                  );
                }
              }
            } catch (cleanupError) {
              reportConfiguredChannelStartupFailure(cleanupError);
            }
          }
          if (runtimeStartupSettled) return;
        }
        if (runtimeStartupSettled) return;
        markServeAppStartupReady();
        await publishLiveDiscovery(candidateApp);
        runtimeStartupSettled = true;
        clearRuntimeStartupTimer();
        markRuntimeReady();
      }, "completeRuntimeStartup");
      const scheduleWorkspaceMcpDiscoveryAfterPreheat = /* @__PURE__ */ __name((app2) => {
        if (runtimeStartupError !== void 0) {
          daemonLog.info(
            "workspace runtime ensure after preheat skipped: runtime startup failed"
          );
          return;
        }
        if (shuttingDown) {
          daemonLog.info(
            "workspace runtime ensure after preheat skipped: shutting down"
          );
          return;
        }
        const registry = app2.locals?.["workspaceRegistry"];
        const primaryEntry = registry?.primaryEntry;
        const runtime = primaryEntry?.state === "active" ? primaryEntry.current?.runtime : void 0;
        if (!runtime) {
          daemonLog.info(
            "workspace runtime ensure after preheat skipped: no primary runtime"
          );
          return;
        }
        const coordinator = getWorkspaceRuntimeCoordinatorIfSupported?.(runtime);
        if (!coordinator) {
          daemonLog.info(
            "workspace runtime ensure after preheat skipped: workspace runtime lifecycle is not supported"
          );
          return;
        }
        void coordinator.ensure({ keepAliveMs: ENSURE_KEEP_ALIVE_MS }).catch((err) => {
          if (shuttingDown || runtimeStartupError !== void 0) {
            return;
          }
          daemonLog.warn(
            `workspace runtime ensure after preheat failed: ${deepestErrorMessage(err)}`
          );
        });
      }, "scheduleWorkspaceMcpDiscoveryAfterPreheat");
      const startBridgePreheat = /* @__PURE__ */ __name((bridge, app2) => {
        startup.preheat.status = "running";
        const preheatStartedAt = performance2.now();
        bridge.preheat().then(() => {
          startup.preheat.status = "succeeded";
          startup.preheat.durationMs = Math.round(
            performance2.now() - preheatStartedAt
          );
          scheduleWorkspaceMcpDiscoveryAfterPreheat(app2);
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          startup.preheat.status = "failed";
          startup.preheat.durationMs = Math.round(
            performance2.now() - preheatStartedAt
          );
          startup.preheat.error = message;
          writeStderrLine(
            `qwen serve: ACP preheat failed, will retry on first session: ${message}`
          );
        });
      }, "startBridgePreheat");
      const startRuntime = /* @__PURE__ */ __name(() => {
        if (runtimeStarting) return false;
        armRuntimeStartupTimer();
        clearRuntimeStartAfterHealthTimer();
        clearRuntimeStartFallbackTimer();
        runtimeStarting = buildRuntime().then(async (runtime) => {
          if (runtimeStartupSettled) {
            disposeRuntimeAppResources(runtime.app);
            await shutdownBridgeAfterFailedStartup(runtime.bridge);
            return;
          }
          bridgeRef = runtime.bridge;
          runtimeAppForCleanup = runtime.app;
          if (shuttingDown) {
            await failRuntimeStartup(
              new Error("Daemon runtime stopped before mounting."),
              runtime.bridge
            );
            return;
          }
          if (shouldPreheat && runtime.bridge) {
            startBridgePreheat(runtime.bridge, runtime.app);
          }
          await completeRuntimeStartup(runtime.app);
        }).catch((err) => failRuntimeStartup(err));
        return true;
      }, "startRuntime");
      startRuntimeForRequest = startRuntime;
      const scheduleRuntimeStartFallback = /* @__PURE__ */ __name(() => {
        if (shuttingDown || runtimeStarting || runtimeStartFallbackTimer)
          return;
        daemonLog.info(
          `deferred runtime: scheduling fallback start in ${FAST_PATH_RUNTIME_START_FALLBACK_MS}ms`
        );
        runtimeStartFallbackTimer = setTimeout(() => {
          runtimeStartFallbackTimer = void 0;
          if (shuttingDown) return;
          daemonLog.info("deferred runtime: fallback timer fired, starting");
          startRuntime();
        }, FAST_PATH_RUNTIME_START_FALLBACK_MS);
        runtimeStartFallbackTimer.unref();
      }, "scheduleRuntimeStartFallback");
      startRuntimeAfterHealth = /* @__PURE__ */ __name(() => {
        if (shuttingDown || runtimeStarting || runtimeStartAfterHealthTimer) {
          return;
        }
        clearRuntimeStartFallbackTimer();
        daemonLog.info(
          `deferred runtime: health served, scheduling start in ${FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS}ms`
        );
        runtimeStartAfterHealthTimer = setTimeout(() => {
          runtimeStartAfterHealthTimer = void 0;
          if (shuttingDown) return;
          daemonLog.info("deferred runtime: health timer fired, starting");
          startRuntime();
        }, FAST_PATH_RUNTIME_START_AFTER_HEALTH_MS);
        runtimeStartAfterHealthTimer.unref();
      }, "startRuntimeAfterHealth");
      const onSignal = /* @__PURE__ */ __name(async (signal) => {
        if (shuttingDown) {
          daemonLog.warn(`received ${signal} during drain \u2014 forcing exit`);
          try {
            managedProcessRegistry?.killAllSync();
            channelWorkerManager?.killAllSync();
            for (const runtimeBridge of getRuntimeBridgesForCleanup()) {
              runtimeBridge.killAllSync();
            }
          } catch (err) {
            daemonLog.error(
              "force-kill error",
              err instanceof Error ? err : null
            );
          }
          await flushDaemonLogBounded(
            daemonLog,
            DAEMON_LOG_FORCED_FLUSH_BUDGET_MS
          );
          process.exit(1);
          return;
        }
        if (!loggerPublished) {
          loggerSignalOwned = true;
          loggerLifecycle.signalOwned();
        }
        daemonLog.warn(`received ${signal}, draining`);
        try {
          await handle.close();
          process.exit(runtimeStartupError === void 0 ? 0 : 1);
        } catch (err) {
          daemonLog.error("shutdown error", err instanceof Error ? err : null);
          if (hasRetryableChannelWorkerShutdownError(err)) {
            daemonLog.error(
              "refusing to exit while a channel worker or service lease remains; signal again to retry after the child exits (another signal during that retry forces exit)"
            );
            return;
          }
          await flushDaemonLogBounded(
            daemonLog,
            DAEMON_LOG_FORCED_FLUSH_BUDGET_MS
          );
          process.exit(1);
        }
      }, "onSignal");
      const onUncaughtExceptionMonitor = /* @__PURE__ */ __name(() => {
        if (process.listenerCount("uncaughtException") === 0 && !channelWorkerManager?.state().enabled) {
          removeCurrentServePidfile();
        }
      }, "onUncaughtExceptionMonitor");
      const handle = {
        server,
        url,
        bridge: handleBridge,
        webShellMounted,
        resolvedToken: token,
        runtimeReady,
        getLocalControl: /* @__PURE__ */ __name(() => (runtimeApp ?? runtimeAppForCleanup)?.locals?.["localControlService"], "getLocalControl"),
        close: /* @__PURE__ */ __name(() => {
          if (closePromise) return closePromise;
          closePromise = new Promise((res, rej) => {
            shuttingDown = true;
            liveDiscoveryShuttingDown = true;
            cancelLiveDiscoveryRetry();
            channelControlDraining = true;
            const initiallyMountedApp = runtimeApp ?? runtimeAppForCleanup;
            const beginRuntimeCoordinatorDrains = /* @__PURE__ */ __name((app2) => {
              const registry = app2?.locals?.["workspaceRegistry"];
              for (const workspaceRuntime of registry?.list() ?? []) {
                getWorkspaceRuntimeCoordinatorIfSupported?.(
                  workspaceRuntime
                )?.beginDrain();
              }
            }, "beginRuntimeCoordinatorDrains");
            beginRuntimeCoordinatorDrains(initiallyMountedApp);
            const initiallyMountedManagement = initiallyMountedApp?.locals?.["workspaceManagementHandle"];
            const initiallyMountedSessionMaintenance = initiallyMountedApp?.locals?.["sessionArchiveCoordinator"];
            const initiallyMountedConversationActivity = initiallyMountedApp?.locals?.["conversationRuntimeActivity"];
            const initialManagementWait = initiallyMountedManagement?.sealAndWait?.();
            const initiallyMountedLive = initiallyMountedApp?.locals;
            const initialLiveWait = initiallyMountedLive?.sealAndWaitLiveCoordinator?.();
            const initialSessionMaintenanceWait = initiallyMountedSessionMaintenance?.sealMaintenanceAndWait?.();
            const initialConversationActivityWait = initiallyMountedConversationActivity?.sealAndWait?.();
            let processRegistryShutdown;
            const startProcessRegistryShutdown = /* @__PURE__ */ __name(() => {
              processRegistryShutdown ??= managedProcessRegistry?.shutdown().then(
                () => void 0,
                (error2) => error2 instanceof Error ? error2 : new Error(String(error2))
              );
            }, "startProcessRegistryShutdown");
            startProcessRegistryShutdown();
            clearRuntimeStartAfterHealthTimer();
            clearRuntimeStartFallbackTimer();
            cancelDeferredRuntimeStartup();
            let settled = false;
            let bridgeShutdownError;
            let channelWorkerShutdownError;
            const finish = /* @__PURE__ */ __name((err) => {
              if (settled) return;
              settled = true;
              const accessLogController = (runtimeApp ?? runtimeAppForCleanup)?.locals?.[ACCESS_LOG_CONTROLLER_LOCAL];
              accessLogController?.sealAndFlushSuppressed();
              const preserveSignalHandlers = channelWorkerShutdownError !== void 0 && channelWorkerManager?.state().enabled === true;
              if (!preserveSignalHandlers) {
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
                process.removeListener("SIGHUP", onSignal);
              }
              process.removeListener(
                "uncaughtExceptionMonitor",
                onUncaughtExceptionMonitor
              );
              void (coreRuntimePromise ? coreRuntimePromise.then((core) => core.shutdownTelemetry()) : Promise.resolve()).catch((telemetryErr) => {
                writeStderrLine(
                  `qwen serve: telemetry shutdown error: ${telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)}`
                );
              }).finally(async () => {
                let finalErr = err ?? bridgeShutdownError ?? channelWorkerShutdownError;
                const retryableChannelClose = channelWorkerShutdownError !== void 0 && channelWorkerManager?.state().enabled === true;
                if (retryableChannelClose) {
                  const retryableError = channelWorkerShutdownError;
                  await flushDaemonLogBounded(
                    daemonLog,
                    DAEMON_LOG_FORCED_FLUSH_BUDGET_MS
                  );
                  closePromise = void 0;
                  shuttingDown = false;
                  channelControlDraining = false;
                  retryableChannelWorkerShutdownErrors.add(retryableError);
                  rej(retryableError);
                  return;
                }
                try {
                  await cleanupLiveDiscovery();
                } catch (cleanupError) {
                  const normalizedCleanupError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                  if (finalErr) {
                    writeDaemonLifecycleBestEffort(() => {
                      daemonLog.error(
                        "Live Host discovery cleanup failed during shutdown",
                        normalizedCleanupError
                      );
                    });
                  }
                  finalErr ??= normalizedCleanupError;
                }
                if (loggerPublished || loggerSignalOwned) {
                  writeDaemonLifecycleBestEffort(() => {
                    if (finalErr) {
                      daemonLog.error("daemon shutdown incomplete", finalErr);
                    } else {
                      daemonLog.info("daemon stopped");
                    }
                  });
                  clearLoaderKeyRejectionReporterIfCurrent(
                    loaderRejectionReporter
                  );
                  await daemonLog.close();
                }
                restoreScrubbedLoaderEnv();
                if (finalErr) rej(finalErr);
                else res();
              });
            }, "finish");
            void (coreRuntimePromise ? coreRuntimePromise.then((core) => core.forceFlushMetrics()) : Promise.resolve()).catch((flushErr) => {
              daemonLog.warn(
                `pre-shutdown metrics flush failed: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`
              );
            });
            Promise.resolve().then(async () => {
              await waitForRuntimeStartingForShutdown(
                runtimeStarting,
                daemonLog
              );
              const appForCleanup = runtimeApp ?? runtimeAppForCleanup;
              const workspaceManagementHandle = appForCleanup?.locals?.["workspaceManagementHandle"];
              const sessionMaintenance = appForCleanup?.locals?.["sessionArchiveCoordinator"];
              const conversationActivity = appForCleanup?.locals?.["conversationRuntimeActivity"];
              await initialManagementWait;
              if (workspaceManagementHandle !== initiallyMountedManagement) {
                await workspaceManagementHandle?.sealAndWait?.();
              }
              const liveLifecycleHandle = appForCleanup?.locals;
              await initialLiveWait;
              if (liveLifecycleHandle !== initiallyMountedLive) {
                await liveLifecycleHandle?.sealAndWaitLiveCoordinator?.();
              }
              await initialSessionMaintenanceWait;
              if (sessionMaintenance !== initiallyMountedSessionMaintenance) {
                await sessionMaintenance?.sealMaintenanceAndWait?.();
              }
              await initialConversationActivityWait;
              if (conversationActivity !== initiallyMountedConversationActivity) {
                await conversationActivity?.sealAndWait?.();
              }
              stopTrustPolicyMonitor(appForCleanup);
              const waitForTrustPolicyIdle = appForCleanup?.locals?.["waitForTrustPolicyIdle"];
              await waitForTrustPolicyIdle?.().catch((err) => {
                daemonLog.error(
                  "workspace trust reconciliation shutdown wait failed",
                  err instanceof Error ? err : null
                );
              });
              beginRuntimeCoordinatorDrains(appForCleanup);
              startProcessRegistryShutdown();
              disposeRuntimeAppResources(appForCleanup);
              disposeDaemonEventLoopMonitor();
              if (channelWorkerManager) {
                await channelWorkerManager.shutdown().catch((err) => {
                  daemonLog.error(
                    "channel worker stop error",
                    err instanceof Error ? err : null
                  );
                  channelWorkerShutdownError = err instanceof Error ? err : new Error(String(err));
                });
              } else {
                removeCurrentServePidfile();
              }
              const runtimeRemoval = appForCleanup?.locals?.["workspaceRuntimeRemoval"];
              const workspaceRegistry = appForCleanup?.locals?.["workspaceRegistry"];
              const managedRuntimeBridges = /* @__PURE__ */ new Set();
              if (runtimeRemoval && workspaceRegistry) {
                const managedRuntimes = workspaceRegistry.listManaged();
                for (const workspaceRuntime of managedRuntimes) {
                  managedRuntimeBridges.add(workspaceRuntime.bridge);
                }
                await Promise.all(
                  managedRuntimes.map(
                    (workspaceRuntime) => runtimeRemoval.disposeRuntime(workspaceRuntime, "daemon_shutdown").catch((err) => {
                      daemonLog.error(
                        "workspace runtime shutdown error",
                        err instanceof Error ? err : null
                      );
                      bridgeShutdownError = err instanceof Error ? err : new Error(String(err));
                      try {
                        workspaceRuntime.bridge.killAllSync();
                      } catch {
                      }
                    })
                  )
                );
              }
              for (const bridgeForShutdown of getRuntimeBridgesForCleanup()) {
                if (managedRuntimeBridges.has(bridgeForShutdown)) continue;
                if (shutdownBridges.has(bridgeForShutdown)) continue;
                shutdownBridges.add(bridgeForShutdown);
                await bridgeForShutdown.shutdown().catch((err) => {
                  shutdownBridges.delete(bridgeForShutdown);
                  daemonLog.error(
                    "bridge shutdown error",
                    err instanceof Error ? err : null
                  );
                  bridgeShutdownError = err instanceof Error ? err : new Error(String(err));
                });
              }
              const processRegistryError = await processRegistryShutdown;
              if (processRegistryError) {
                daemonLog.error(
                  "ACP process registry shutdown error",
                  processRegistryError
                );
                bridgeShutdownError ??= processRegistryError;
              }
            }).then(
              () => finish(),
              (error2) => finish(
                error2 instanceof Error ? error2 : new Error(String(error2))
              )
            );
          });
          return closePromise;
        }, "close")
      };
      closeHost = handle.close;
      handle.close = () => serveAppLifecycle.close();
      try {
        channelWorkspaceGroups = resolveChannelWorkspaceGroupsAtListen();
      } catch (err) {
        removeCurrentServePidfile();
        const error2 = err instanceof Error ? err : new Error(String(err));
        if (channelSelectionFromSettings) {
          opts.channelSelection = void 0;
          reportConfiguredChannelStartupFailure(error2);
        } else {
          markServeAppStartupFailed(error2);
          void serveAppLifecycle.close().then(
            () => reject(error2),
            (closeError) => reject(
              closeError instanceof Error ? new AggregateError([error2, closeError], error2.message) : error2
            )
          );
          return;
        }
      }
      if (channelWorkspaceGroups) {
        for (const group of channelWorkspaceGroups) {
          daemonLog.info("channel worker group assigned", {
            workspace: group.workspaceCwd,
            channels: group.selection.mode === "all" ? ["all"] : group.selection.names
          });
        }
        if (opts.channelSelection?.mode === "all") {
          writeStderrLine(
            channelSelectionFromSettings ? 'qwen serve: workspace serve.channels selection "all" is primary-workspace only; non-primary workspace channels are not hosted.' : "qwen serve: --channel all is primary-workspace only; non-primary workspace channels are not hosted."
          );
        }
      }
      writeStdoutLine(
        `qwen serve listening on ${url} (mode=${opts.mode}, workspace=${boundWorkspace})`
      );
      const boundAddress = typeof addr === "object" && addr ? addr.address : opts.hostname;
      if (token) {
        void printRemoteQuickstart({
          bind: opts.hostname,
          boundAddress,
          port: actualPort,
          tls: Boolean(tlsOptions),
          token,
          generated: generatedToken,
          web: webShellMounted
        });
      }
      writeStderrLine(
        `qwen serve: bound to workspace ${JSON.stringify(boundWorkspace)}`
      );
      writeStderrLine(
        `qwen serve: startup timing: processToListenMs=${startup.processToListenMs} runQwenServeToListenMs=${startup.runQwenServeToListenMs}`
      );
      if (!token) {
        writeStderrLine(
          `qwen serve: trusted loopback mode; local callers have full API access without bearer authentication, including code execution as the daemon user. Use --require-auth with ${QWEN_SERVER_TOKEN_ENV} on shared or untrusted hosts.`
        );
        if (opts.clientMcpOverWs === true) {
          writeStderrLine(
            `qwen serve: client-hosted MCP tools are accepted over the WebSocket without auth. Set ${QWEN_SERVE_CLIENT_MCP_OVER_WS_ENV}=0 to disable.`
          );
        }
      } else if (opts.requireAuth) {
        writeStderrLine(
          "qwen serve: --require-auth enabled (bearer token mandatory on every route, including loopback /health)."
        );
      }
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      process.on("SIGHUP", onSignal);
      process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
      server.on("error", (err) => {
        daemonLog.error("server error", err instanceof Error ? err : null);
      });
      const preparedRuntimeApp = runtimeApp ?? runtimeAppForCleanup;
      if (preparedRuntimeApp && bridgeRef && deps.bridge) {
        runtimeApp ??= preparedRuntimeApp;
        attachLiveDiscoveryControl(preparedRuntimeApp);
        if (shouldPreheat) {
          startBridgePreheat(bridgeRef, preparedRuntimeApp);
        }
        if (opts.channelSelection && !runtimeStartupSettled) {
          armRuntimeStartupTimer();
          runtimeStarting = completeRuntimeStartup(preparedRuntimeApp).catch(
            (err) => failRuntimeStartup(err, bridgeRef)
          );
        } else {
          const acpHandle = preparedRuntimeApp.locals?.["acpHandle"];
          acpHandle?.attachServer?.(server);
          markServeAppStartupReady();
          void publishLiveDiscovery(preparedRuntimeApp);
          if (!runtimeStartupSettled) {
            runtimeStartupSettled = true;
            clearRuntimeStartupTimer();
            markRuntimeReady();
          }
        }
      } else if (deferRuntimeUntilFirstHealth) {
        scheduleRuntimeStartFallback();
      } else {
        startRuntime();
      }
      if (deps.resolveOnListen) {
        loggerPublished = true;
        loggerLifecycle.published();
        void (liveDiscoveryPublish ?? Promise.resolve()).then(
          () => resolve3(handle)
        );
      } else {
        void runtimeReady.then(
          async () => {
            await liveDiscoveryPublish;
            loggerPublished = true;
            loggerLifecycle.published();
            resolve3(handle);
          },
          (err) => {
            void handle.close().then(
              () => {
                reject(err instanceof Error ? err : new Error(String(err)));
              },
              (closeErr) => {
                writeDaemonLifecycleBestEffort(
                  () => daemonLog.error(
                    "shutdown after runtime startup error failed",
                    closeErr instanceof Error ? closeErr : null
                  )
                );
                if (hasRetryableChannelWorkerShutdownError(closeErr)) {
                  writeDaemonLifecycleBestEffort(
                    () => daemonLog.error(
                      "runtime startup failed, but qwen serve remains alive to retain the channel service lease until worker exit is confirmed"
                    )
                  );
                  return;
                }
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            );
          }
        );
      }
    }, "onListening");
    let server;
    if (tlsOptions) {
      try {
        server = https.createServer(tlsOptions, app);
      } catch (err) {
        reject(
          new Error(
            `--tls-cert "${opts.tlsCert}" and --tls-key "${opts.tlsKey}" could not be loaded (do they match?): ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }
    } else {
      server = deps.httpServerFactory?.(app) ?? createServer(app);
    }
    serveAppLifecycle.bindServer(server, {
      startupReady: serveAppStartupReady,
      drainHost: /* @__PURE__ */ __name(() => {
        if (closeHost) return closeHost();
        if (!server.listening) return Promise.resolve();
        return new Promise((resolve4, rejectClose) => {
          server.close((error) => {
            if (error) rejectClose(error);
            else resolve4();
          });
        });
      }, "drainHost")
    });
    const tryListen = /* @__PURE__ */ __name((attemptPort, attempt) => {
      const handleListening = /* @__PURE__ */ __name(() => {
        server.removeListener("error", handleError);
        const address = server.address();
        if (trustedLoopbackMode && (typeof address !== "object" || address === null || !isLoopbackAddress(address.address))) {
          const resolvedAddress = typeof address === "object" && address !== null ? address.address : String(address);
          const error = new Error(
            `Refusing trusted-loopback mode because ${opts.hostname} bound to non-loopback address ${resolvedAddress}. Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or bind to an explicit loopback address.`
          );
          removeCurrentServePidfile();
          markServeAppStartupFailed(error);
          void serveAppLifecycle.close().then(
            () => reject(error),
            (closeError) => reject(
              closeError instanceof Error ? new AggregateError([error, closeError], error.message) : error
            )
          );
          return;
        }
        onListening();
      }, "handleListening");
      const handleError = /* @__PURE__ */ __name((err) => {
        server.removeListener("listening", handleListening);
        const nextPort = attemptPort + 1;
        if (err.code === "EADDRINUSE" && opts.port !== 0 && nextPort <= 65535 && attempt < MAX_PORT_ATTEMPTS - 1) {
          writeStderrLine(
            `qwen serve: port ${attemptPort} is in use, trying ${nextPort}...`
          );
          tryListen(nextPort, attempt + 1);
          return;
        }
        if (err.code === "EADDRINUSE" && attempt > 0) {
          writeStderrLine(
            `qwen serve: all ports ${opts.port}\u2013${attemptPort} are in use`
          );
        }
        removeCurrentServePidfile();
        markServeAppStartupFailed(err);
        void serveAppLifecycle.close().then(
          () => reject(err),
          (closeError) => reject(
            closeError instanceof Error ? new AggregateError([err, closeError], err.message) : err
          )
        );
      }, "handleError");
      try {
        server.once("listening", handleListening);
        server.once("error", handleError);
        server.listen(attemptPort, listenHostname);
      } catch (err) {
        removeCurrentServePidfile();
        server.removeListener("listening", handleListening);
        server.removeListener("error", handleError);
        const error = err instanceof Error ? err : new Error(String(err));
        markServeAppStartupFailed(error);
        void serveAppLifecycle.close().then(
          () => reject(error),
          (closeError) => reject(
            closeError instanceof Error ? new AggregateError([error, closeError], error.message) : error
          )
        );
        return;
      }
    }, "tryListen");
    tryListen(opts.port, 0);
  });
}
__name(runQwenServeImpl, "runQwenServeImpl");
export {
  InvalidPolicyConfigError,
  assertChannelWorkerDaemonUrlIsLocal,
  createBoundChannelDeliveryHandler,
  createDisabledChannelWorkerSupervisor,
  createLazyBridgeProxy,
  describeWorkerTlsTrustGaps,
  extractContextFilename,
  formatChannelWorkerDaemonUrl,
  resolveRuntimeStartupTimeoutMs,
  runQwenServe,
  subSessionConcurrencyCapsFromSettings,
  validateAndCanonicalizeWorkspaceInput,
  validatePolicyConfig,
  verifyWorkerTlsTrust,
  waitForRuntimeStartingForShutdown
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
