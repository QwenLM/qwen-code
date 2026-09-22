// Force strict mode and setup for ESM
"use strict";
import {
  getHeadlessYoloSafetyWarning
} from "./chunk-6H67XLET.js";
import {
  RUNTIME_STARTUP_CANCELLED_MESSAGE
} from "./chunk-QUPXZXLV.js";
import {
  MAX_COMPACTED_REPLAY_MAX_BYTES
} from "./chunk-WCCLLK7X.js";
import {
  isValidMemoryBudgetMb,
  memoryBudgetRangeError
} from "./chunk-LYD3T3H7.js";
import {
  normalizeServeFastPathArgv
} from "./chunk-JVEGA3MM.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/fast-path.ts
init_esbuild_shims();
var HELP_AND_VERSION_FLAGS = /* @__PURE__ */ new Set(["--help", "-h", "--version", "-v"]);
var MCP_BUDGET_WARN_FRACTION = 0.75;
var NUMBER_OPTIONS = /* @__PURE__ */ new Map([
  ["port", "port"],
  ["maxSessions", "max-sessions"],
  ["maxTotalSessions", "max-total-sessions"],
  ["maxPendingPromptsPerSession", "max-pending-prompts-per-session"],
  ["maxConnections", "max-connections"],
  ["eventRingSize", "event-ring-size"],
  ["compactedReplayMaxBytes", "compacted-replay-max-bytes"],
  ["maxJournalEvents", "max-journal-events"],
  ["maxJournalBytes", "max-journal-bytes"],
  ["mcp-client-budget", "mcp-client-budget"],
  ["memoryBudgetMb", "memory-budget-mb"],
  ["promptDeadlineMs", "prompt-deadline-ms"],
  ["writerIdleTimeoutMs", "writer-idle-timeout-ms"],
  ["channelIdleTimeoutMs", "channel-idle-timeout-ms"],
  ["initializeTimeoutMs", "initialize-timeout-ms"],
  ["sessionRestoreTimeoutMs", "session-restore-timeout-ms"],
  ["sessionReapIntervalMs", "session-reap-interval-ms"],
  ["sessionIdleTimeoutMs", "session-idle-timeout-ms"],
  ["sessionPromptSettledCloseGraceMs", "session-prompt-settled-close-grace-ms"],
  ["permissionResponseTimeoutMs", "permission-response-timeout-ms"],
  ["rateLimitPrompt", "rate-limit-prompt"],
  ["rateLimitMutation", "rate-limit-mutation"],
  ["rateLimitRead", "rate-limit-read"],
  ["rateLimitWindowMs", "rate-limit-window-ms"]
]);
var NUMBER_OPTION_BY_FLAG = invertOptionMap(NUMBER_OPTIONS);
var STRING_OPTION_BY_FLAG = /* @__PURE__ */ new Map([
  ["hostname", "hostname"],
  ["token", "token"],
  ["workspace", "workspace"],
  ["memory-project-scope", "memoryProjectScope"],
  ["tls-cert", "tlsCert"],
  ["tls-key", "tlsKey"]
]);
var BOOLEAN_OPTION_BY_FLAG = /* @__PURE__ */ new Map([
  ["require-auth", "requireAuth"],
  ["enable-session-shell", "enableSessionShell"],
  ["web", "serveWebShell"],
  ["open", "open"],
  ["open-with-auth", "open-with-auth"],
  ["http-bridge", "http-bridge"],
  ["allow-private-auth-base-url", "allowPrivateAuthBaseUrl"],
  ["experimental-lsp", "experimentalLsp"],
  ["restore-ask-user-question", "restoreAskUserQuestion"],
  ["rate-limit", "rateLimit"]
]);
function invertOptionMap(source) {
  const out = /* @__PURE__ */ new Map();
  for (const [target, flag] of source) {
    out.set(flag, target);
  }
  return out;
}
__name(invertOptionMap, "invertOptionMap");
function readOptionValue(argv, index, inlineValue) {
  if (inlineValue !== void 0) {
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === void 0 || value.startsWith("-")) {
    return null;
  }
  return { value, nextIndex: index + 1 };
}
__name(readOptionValue, "readOptionValue");
function parseNumber(value) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}
__name(parseNumber, "parseNumber");
function parseBooleanValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
__name(parseBooleanValue, "parseBooleanValue");
function parsePositiveIntegerEnv(raw) {
  if (raw === void 0 || raw === "") return void 0;
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}
__name(parsePositiveIntegerEnv, "parsePositiveIntegerEnv");
function isTruthyEnv(value) {
  return value === "1" || value === "true";
}
__name(isTruthyEnv, "isTruthyEnv");
function writeStderrLine(line) {
  process.stderr.write(line.endsWith("\n") ? line : `${line}
`);
}
__name(writeStderrLine, "writeStderrLine");
function setServeOption(options, key, value) {
  options[key] = value;
}
__name(setServeOption, "setServeOption");
function getRateLimitValidationError(options) {
  for (const [name, value] of [
    ["--rate-limit-prompt", options.rateLimitPrompt],
    ["--rate-limit-mutation", options.rateLimitMutation],
    ["--rate-limit-read", options.rateLimitRead]
  ]) {
    if (value !== void 0 && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
      return `qwen serve: ${name} must be a positive integer.`;
    }
  }
  if (options.rateLimitWindowMs !== void 0 && (!Number.isFinite(options.rateLimitWindowMs) || !Number.isInteger(options.rateLimitWindowMs) || options.rateLimitWindowMs < 1e3)) {
    return "qwen serve: --rate-limit-window-ms must be an integer >= 1000.";
  }
  return null;
}
__name(getRateLimitValidationError, "getRateLimitValidationError");
function getServeFastPathValidationError(parsed) {
  const mcpClientBudget = parsed.options.mcpClientBudget;
  if (mcpClientBudget !== void 0 && (!Number.isFinite(mcpClientBudget) || !Number.isInteger(mcpClientBudget) || mcpClientBudget <= 0)) {
    return "qwen serve: --mcp-client-budget must be a positive integer.";
  }
  if (parsed.options.mcpBudgetMode === "enforce" && mcpClientBudget === void 0) {
    return "qwen serve: --mcp-budget-mode=enforce requires --mcp-client-budget=N.";
  }
  const maxPendingPromptsPerSession = parsed.options.maxPendingPromptsPerSession;
  if (maxPendingPromptsPerSession !== void 0 && maxPendingPromptsPerSession !== Number.POSITIVE_INFINITY && (!Number.isFinite(maxPendingPromptsPerSession) || !Number.isInteger(maxPendingPromptsPerSession) || maxPendingPromptsPerSession < 0)) {
    return "qwen serve: --max-pending-prompts-per-session must be a non-negative integer (0 / Infinity = unlimited).";
  }
  const compactedReplayMaxBytes = parsed.options.compactedReplayMaxBytes;
  if (compactedReplayMaxBytes !== void 0 && (!Number.isSafeInteger(compactedReplayMaxBytes) || compactedReplayMaxBytes < 1 || compactedReplayMaxBytes > MAX_COMPACTED_REPLAY_MAX_BYTES)) {
    return `qwen serve: --compacted-replay-max-bytes must be a positive safe integer in [1, ${MAX_COMPACTED_REPLAY_MAX_BYTES}].`;
  }
  const maxJournalEvents = parsed.options.maxJournalEvents;
  if (maxJournalEvents !== void 0 && (!Number.isSafeInteger(maxJournalEvents) || maxJournalEvents < 1)) {
    return "qwen serve: --max-journal-events must be a positive safe integer.";
  }
  const maxJournalBytes = parsed.options.maxJournalBytes;
  if (maxJournalBytes !== void 0 && (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1)) {
    return "qwen serve: --max-journal-bytes must be a positive safe integer.";
  }
  const memoryBudgetMb = parsed.options.memoryBudgetMb;
  if (memoryBudgetMb !== void 0 && !isValidMemoryBudgetMb(memoryBudgetMb)) {
    return memoryBudgetRangeError();
  }
  return null;
}
__name(getServeFastPathValidationError, "getServeFastPathValidationError");
function blockForever() {
  return new Promise(() => {
  });
}
__name(blockForever, "blockForever");
async function waitForServeRuntimeOrExit(handle) {
  try {
    await handle.runtimeReady;
  } catch (err) {
    if (err instanceof Error && err.message === RUNTIME_STARTUP_CANCELLED_MESSAGE) {
      return;
    }
    writeStderrLine(
      `qwen serve: runtime startup failed after listener was ready: ${err instanceof Error ? err.message : String(err)}`
    );
    await handle.close().catch(() => void 0);
    process.exit(1);
  }
}
__name(waitForServeRuntimeOrExit, "waitForServeRuntimeOrExit");
function applyRateLimitEnvDefaults(options, env) {
  if (options.rateLimit === void 0 && isTruthyEnv(env["QWEN_SERVE_RATE_LIMIT"])) {
    options.rateLimit = true;
  }
  if (options.rateLimit) {
    options.rateLimitPrompt ??= parsePositiveIntegerEnv(
      env["QWEN_SERVE_RATE_LIMIT_PROMPT"]
    );
    options.rateLimitMutation ??= parsePositiveIntegerEnv(
      env["QWEN_SERVE_RATE_LIMIT_MUTATION"]
    );
    options.rateLimitRead ??= parsePositiveIntegerEnv(
      env["QWEN_SERVE_RATE_LIMIT_READ"]
    );
    options.rateLimitWindowMs ??= parsePositiveIntegerEnv(
      env["QWEN_SERVE_RATE_LIMIT_WINDOW_MS"]
    );
  }
}
__name(applyRateLimitEnvDefaults, "applyRateLimitEnvDefaults");
function discardRateLimitTuningWhenDisabled(options) {
  if (options.rateLimit === true) return;
  delete options.rateLimitPrompt;
  delete options.rateLimitMutation;
  delete options.rateLimitRead;
  delete options.rateLimitWindowMs;
}
__name(discardRateLimitTuningWhenDisabled, "discardRateLimitTuningWhenDisabled");
async function bootstrapServeFastPathEnvironment(workspace) {
  const {
    loadServeFastPathEnvironment,
    loadServeFastPathSettings,
    preResolveServeFastPathHomeEnvOverrides
  } = await import("./fast-path-settings-ASPHHCAG.js");
  preResolveServeFastPathHomeEnvOverrides();
  const workspaceDir = workspace ?? process.cwd();
  const settings = loadServeFastPathSettings(workspaceDir);
  loadServeFastPathEnvironment(settings, workspaceDir);
  return settings;
}
__name(bootstrapServeFastPathEnvironment, "bootstrapServeFastPathEnvironment");
function parseServeFastPathArgs(rawArgv, env = process.env) {
  const argv = normalizeServeFastPathArgv(rawArgv);
  if (argv[0] !== "serve") return { kind: "fallback" };
  if (argv.some((arg) => HELP_AND_VERSION_FLAGS.has(arg))) {
    return { kind: "fallback" };
  }
  const options = {
    hostname: "127.0.0.1",
    mode: "http-bridge",
    port: 4170
  };
  let open = false;
  let openWithAuth = false;
  let httpBridge = true;
  let mcpBudgetModeRaw;
  let mcpClientBudget;
  let explicitRateLimit;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return { kind: "fallback" };
    if (!arg.startsWith("--")) return { kind: "fallback" };
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const rawFlag = equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? void 0 : withoutPrefix.slice(equalsIndex + 1);
    const negated = rawFlag.startsWith("no-");
    const flag = negated ? rawFlag.slice(3) : rawFlag;
    const booleanTarget = BOOLEAN_OPTION_BY_FLAG.get(flag);
    if (booleanTarget) {
      let value = !negated;
      if (inlineValue !== void 0) {
        const parsed = parseBooleanValue(inlineValue);
        if (parsed === null || negated) return { kind: "fallback" };
        value = parsed;
      }
      if (booleanTarget === "open") {
        open = value;
      } else if (booleanTarget === "open-with-auth") {
        openWithAuth = value;
      } else if (booleanTarget === "http-bridge") {
        httpBridge = value;
      } else {
        setServeOption(options, booleanTarget, value);
        if (booleanTarget === "rateLimit") {
          explicitRateLimit = value;
        }
      }
      continue;
    }
    if (negated) return { kind: "fallback" };
    const numberTarget = NUMBER_OPTION_BY_FLAG.get(flag);
    if (numberTarget) {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      const value = parseNumber(read.value);
      if (value === null) return { kind: "fallback" };
      if (numberTarget === "mcp-client-budget") {
        mcpClientBudget = value;
      } else {
        setServeOption(options, numberTarget, value);
      }
      continue;
    }
    const stringTarget = STRING_OPTION_BY_FLAG.get(flag);
    if (stringTarget) {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      if (stringTarget === "workspace" && (options.workspace !== void 0 || read.value === "")) {
        return { kind: "fallback" };
      }
      setServeOption(options, stringTarget, read.value);
      continue;
    }
    if (flag === "memory-pressure-mode") {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      if (read.value !== "off" && read.value !== "observe") {
        return { kind: "fallback" };
      }
      options.memoryPressureMode = read.value;
      continue;
    }
    if (flag === "child-heap-mode") {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      if (read.value !== "off" && read.value !== "observe" && read.value !== "admit") {
        return { kind: "fallback" };
      }
      options.childHeapMode = read.value;
      continue;
    }
    if (flag === "mcp-budget-mode") {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      mcpBudgetModeRaw = read.value;
      continue;
    }
    if (flag === "allow-origin") {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: "fallback" };
      i = read.nextIndex;
      options.allowOrigins = [...options.allowOrigins ?? [], read.value];
      continue;
    }
    return { kind: "fallback" };
  }
  if (mcpBudgetModeRaw !== void 0 && mcpBudgetModeRaw !== "enforce" && mcpBudgetModeRaw !== "warn" && mcpBudgetModeRaw !== "off") {
    return { kind: "fallback" };
  }
  if (options.memoryProjectScope !== void 0 && options.memoryProjectScope !== "git-root" && options.memoryProjectScope !== "workspace") {
    return { kind: "fallback" };
  }
  const mcpBudgetMode = mcpBudgetModeRaw ?? (mcpClientBudget !== void 0 ? "warn" : "off");
  if (mcpClientBudget !== void 0) options.mcpClientBudget = mcpClientBudget;
  options.mcpBudgetMode = mcpBudgetMode;
  if (explicitRateLimit !== void 0) {
    options.rateLimit = explicitRateLimit;
  }
  applyRateLimitEnvDefaults(options, env);
  return {
    kind: "serve",
    open: open || openWithAuth,
    openWithAuth,
    httpBridge,
    options
  };
}
__name(parseServeFastPathArgs, "parseServeFastPathArgs");
async function maybeOpenWebShellBrowser(handle, open, openWithAuth) {
  if (!open) return;
  try {
    await handle.runtimeReady;
  } catch {
    return;
  }
  const { maybeOpenWebShellBrowser: openBrowser } = await import("./serve-KKVOUE53.js");
  await openBrowser(handle, true, openWithAuth);
}
__name(maybeOpenWebShellBrowser, "maybeOpenWebShellBrowser");
function emitHeadlessYoloWarning(settings) {
  if (!settings) return;
  const warning = getHeadlessYoloSafetyWarning({
    getApprovalMode: /* @__PURE__ */ __name(() => settings.tools?.approvalMode, "getApprovalMode"),
    getSandbox: /* @__PURE__ */ __name(() => settings.tools?.sandbox, "getSandbox")
  });
  if (warning) {
    writeStderrLine(warning);
  }
}
__name(emitHeadlessYoloWarning, "emitHeadlessYoloWarning");
function writeServeWarnings(parsed) {
  if (!parsed.httpBridge) {
    writeStderrLine(
      "qwen serve: --no-http-bridge (native mode) is not yet implemented; falling back to http-bridge."
    );
  }
  if (parsed.options.token) {
    writeStderrLine(
      "qwen serve: --token is visible in the process command line; prefer the QWEN_SERVER_TOKEN env var for any non-trivial deployment."
    );
  }
  const mcpClientBudget = parsed.options.mcpClientBudget;
  if (mcpClientBudget !== void 0) {
    const resolvedMcpMode = parsed.options.mcpBudgetMode ?? "warn";
    writeStderrLine(
      `qwen serve: --mcp-client-budget=${mcpClientBudget} mode=${resolvedMcpMode}` + (resolvedMcpMode === "enforce" ? " (servers past the cap will be refused at discovery)" : resolvedMcpMode === "warn" ? ` (warnings at >=${Math.ceil(mcpClientBudget * MCP_BUDGET_WARN_FRACTION)}, no refusal)` : "")
    );
  }
}
__name(writeServeWarnings, "writeServeWarnings");
async function tryRunServeFastPath(rawArgv = process.argv.slice(2)) {
  const parsed = parseServeFastPathArgs(rawArgv);
  if (parsed.kind === "fallback") return false;
  const validationError = getServeFastPathValidationError(parsed) || (parsed.options.rateLimit === true ? getRateLimitValidationError(parsed.options) : null);
  if (validationError) {
    writeStderrLine(validationError);
    process.exit(1);
  }
  let settings;
  try {
    settings = await bootstrapServeFastPathEnvironment(
      parsed.options.workspace
    );
  } catch (err) {
    writeStderrLine(
      `qwen serve: fast-path bootstrap failed, falling back to full startup: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  applyRateLimitEnvDefaults(parsed.options, process.env);
  discardRateLimitTuningWhenDisabled(parsed.options);
  const rateLimitError = getRateLimitValidationError(parsed.options);
  if (rateLimitError) {
    writeStderrLine(rateLimitError);
    process.exit(1);
  }
  writeServeWarnings(parsed);
  if (parsed.openWithAuth) {
    try {
      const { applyOpenWithAuth } = await import("./open-with-auth-XFCCJOO6.js");
      applyOpenWithAuth(parsed.options);
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  }
  const { runQwenServe } = await import("./run-qwen-serve-J7YTW3QA.js");
  let handle;
  try {
    handle = await runQwenServe(parsed.options, {
      ...settings ? { bootSettings: settings } : {},
      resolveOnListen: true,
      deferRuntimeUntilFirstHealth: !parsed.open
    });
    try {
      emitHeadlessYoloWarning(settings);
    } catch {
    }
    await maybeOpenWebShellBrowser(handle, parsed.open, parsed.openWithAuth);
  } catch (err) {
    writeStderrLine(
      `qwen serve: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  await waitForServeRuntimeOrExit(handle);
  await blockForever();
  return true;
}
__name(tryRunServeFastPath, "tryRunServeFastPath");
export {
  bootstrapServeFastPathEnvironment,
  parseServeFastPathArgs,
  tryRunServeFastPath,
  waitForServeRuntimeOrExit
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
