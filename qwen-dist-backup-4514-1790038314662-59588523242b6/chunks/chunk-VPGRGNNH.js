// Force strict mode and setup for ESM
"use strict";
import {
  SchemaValidator
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/tool-error.ts
init_esbuild_shims();

// packages/core/src/utils/tool-error-type.ts
init_esbuild_shims();

// packages/core/src/tools/tool-error.ts
var StructuredToolError = class extends Error {
  constructor(message, errorType) {
    super(message);
    this.errorType = errorType;
  }
  static {
    __name(this, "StructuredToolError");
  }
  name = "StructuredToolError";
};

// packages/core/src/tools/tools.ts
init_esbuild_shims();

// packages/core/src/agents/runtime/agent-statistics.ts
init_esbuild_shims();
var AgentStatistics = class {
  static {
    __name(this, "AgentStatistics");
  }
  startTimeMs = 0;
  rounds = 0;
  totalToolCalls = 0;
  successfulToolCalls = 0;
  failedToolCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  thoughtTokens = 0;
  cachedTokens = 0;
  apiTotalTokens = 0;
  toolUsage = /* @__PURE__ */ new Map();
  reset() {
    this.startTimeMs = 0;
    this.rounds = 0;
    this.totalToolCalls = 0;
    this.successfulToolCalls = 0;
    this.failedToolCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thoughtTokens = 0;
    this.cachedTokens = 0;
    this.apiTotalTokens = 0;
    this.toolUsage.clear();
  }
  start(now = Date.now()) {
    this.startTimeMs = now;
  }
  setRounds(rounds) {
    this.rounds = rounds;
  }
  recordToolCall(name, success, durationMs, lastError) {
    this.totalToolCalls += 1;
    if (success) this.successfulToolCalls += 1;
    else this.failedToolCalls += 1;
    const tu = this.toolUsage.get(name) || {
      name,
      count: 0,
      success: 0,
      failure: 0,
      lastError: void 0,
      totalDurationMs: 0,
      averageDurationMs: 0
    };
    tu.count += 1;
    if (success) tu.success += 1;
    else tu.failure += 1;
    if (lastError) tu.lastError = lastError;
    tu.totalDurationMs += Math.max(0, durationMs || 0);
    tu.averageDurationMs = tu.count > 0 ? tu.totalDurationMs / tu.count : 0;
    this.toolUsage.set(name, tu);
  }
  recordTokens(input, output, thought = 0, cached = 0, total = 0) {
    this.inputTokens += Math.max(0, input || 0);
    this.outputTokens += Math.max(0, output || 0);
    this.thoughtTokens += Math.max(0, thought || 0);
    this.cachedTokens += Math.max(0, cached || 0);
    this.apiTotalTokens += Math.max(0, total || 0);
  }
  getSummary(now = Date.now()) {
    const totalDurationMs = this.startTimeMs ? now - this.startTimeMs : 0;
    const totalToolCalls = this.totalToolCalls;
    const successRate = totalToolCalls > 0 ? this.successfulToolCalls / totalToolCalls * 100 : 0;
    const totalTokens = this.apiTotalTokens > 0 ? this.apiTotalTokens : this.inputTokens + this.outputTokens + this.thoughtTokens;
    return {
      rounds: this.rounds,
      totalDurationMs,
      totalToolCalls,
      successfulToolCalls: this.successfulToolCalls,
      failedToolCalls: this.failedToolCalls,
      successRate,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      thoughtTokens: this.thoughtTokens,
      cachedTokens: this.cachedTokens,
      totalTokens,
      toolUsage: Array.from(this.toolUsage.values())
    };
  }
  formatCompact(taskDesc, now = Date.now()) {
    const stats = this.getSummary(now);
    const sr = stats.totalToolCalls > 0 ? stats.successRate ?? stats.successfulToolCalls / stats.totalToolCalls * 100 : 0;
    const lines = [
      `\u25B8 Task Completed: ${taskDesc}`,
      `\u25CF Tool Usage: ${stats.totalToolCalls} calls${stats.totalToolCalls ? `, ${sr.toFixed(1)}% success` : ""}`,
      `\u25CF Duration: ${this.fmtDuration(stats.totalDurationMs)} | \u25CF Rounds: ${stats.rounds}`
    ];
    if (typeof stats.totalTokens === "number") {
      const parts = [
        `in ${stats.inputTokens ?? 0}`,
        `out ${stats.outputTokens ?? 0}`
      ];
      lines.push(
        `\u25CF Tokens: ${stats.totalTokens.toLocaleString()}${parts.length ? ` (${parts.join(", ")})` : ""}`
      );
    }
    return lines.join("\n");
  }
  formatDetailed(taskDesc, now = Date.now()) {
    const stats = this.getSummary(now);
    const sr = stats.totalToolCalls > 0 ? stats.successRate ?? stats.successfulToolCalls / stats.totalToolCalls * 100 : 0;
    const lines = [];
    lines.push(`\u25B8 Task Completed: ${taskDesc}`);
    lines.push(
      `\u25CF Duration: ${this.fmtDuration(stats.totalDurationMs)} | \u25CF Rounds: ${stats.rounds}`
    );
    let quality = "Poor execution";
    if (sr >= 95) quality = "Excellent execution";
    else if (sr >= 85) quality = "Good execution";
    else if (sr >= 70) quality = "Fair execution";
    lines.push(`\u2713 Quality: ${quality} (${sr.toFixed(1)}% tool success)`);
    const d = stats.totalDurationMs;
    let speed = "Long execution - consider breaking down tasks";
    if (d < 1e4) speed = "Fast completion - under 10 seconds";
    else if (d < 6e4) speed = "Good speed - under a minute";
    else if (d < 3e5) speed = "Moderate duration - a few minutes";
    lines.push(`\u25CF Speed: ${speed}`);
    lines.push(
      `\u25CF Tools: ${stats.totalToolCalls} calls, ${sr.toFixed(1)}% success (${stats.successfulToolCalls} ok, ${stats.failedToolCalls} failed)`
    );
    if (typeof stats.totalTokens === "number") {
      const parts = [
        `in ${stats.inputTokens ?? 0}`,
        `out ${stats.outputTokens ?? 0}`
      ];
      lines.push(
        `\u25CF Tokens: ${stats.totalTokens.toLocaleString()} (${parts.join(", ")})`
      );
    }
    if (stats.toolUsage && stats.toolUsage.length) {
      const sorted = [...stats.toolUsage].sort((a, b) => b.count - a.count).slice(0, 5);
      lines.push("\nTop tools:");
      for (const t of sorted) {
        const avg = typeof t.averageDurationMs === "number" ? `, avg ${this.fmtDuration(Math.round(t.averageDurationMs))}` : "";
        lines.push(
          ` - ${t.name}: ${t.count} calls (${t.success} ok, ${t.failure} fail${avg}${t.lastError ? `, last error: ${t.lastError}` : ""})`
        );
      }
    }
    const tips = this.generatePerformanceTips(stats);
    if (tips.length) {
      lines.push("\n\u2605 Performance Insights:");
      for (const tip of tips.slice(0, 3)) lines.push(` - ${tip}`);
    }
    return lines.join("\n");
  }
  fmtDuration(ms) {
    if (ms < 1e3) return `${Math.round(ms)}ms`;
    if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
    if (ms < 36e5) {
      const m2 = Math.floor(ms / 6e4);
      const s = Math.floor(ms % 6e4 / 1e3);
      return `${m2}m ${s}s`;
    }
    const h = Math.floor(ms / 36e5);
    const m = Math.floor(ms % 36e5 / 6e4);
    return `${h}h ${m}m`;
  }
  generatePerformanceTips(stats) {
    const tips = [];
    const totalCalls = stats.totalToolCalls;
    const sr = stats.totalToolCalls > 0 ? stats.successRate ?? stats.successfulToolCalls / stats.totalToolCalls * 100 : 0;
    if (sr < 80)
      tips.push("Low tool success rate - review inputs and error messages");
    if (stats.totalDurationMs > 6e4)
      tips.push("Long execution time - consider breaking down complex tasks");
    if (typeof stats.totalTokens === "number" && stats.totalTokens > 1e5) {
      tips.push(
        "High token usage - consider optimizing prompts or narrowing scope"
      );
    }
    if (typeof stats.totalTokens === "number" && totalCalls > 0) {
      const avgTokPerCall = stats.totalTokens / totalCalls;
      if (avgTokPerCall > 5e3)
        tips.push(
          `High token usage per tool call (~${Math.round(avgTokPerCall)} tokens/call)`
        );
    }
    const isNetworkTool = /* @__PURE__ */ __name((name) => /web|fetch|search/i.test(name), "isNetworkTool");
    const hadNetworkFailure = (stats.toolUsage || []).some(
      (t) => isNetworkTool(t.name) && t.lastError && /timeout|network/i.test(t.lastError)
    );
    if (hadNetworkFailure)
      tips.push(
        "Network operations had failures - consider increasing timeout or checking connectivity"
      );
    const slow = (stats.toolUsage || []).filter((t) => (t.averageDurationMs ?? 0) > 1e4).sort((a, b) => (b.averageDurationMs ?? 0) - (a.averageDurationMs ?? 0));
    if (slow.length)
      tips.push(
        `Consider optimizing ${slow[0].name} operations (avg ${this.fmtDuration(Math.round(slow[0].averageDurationMs))})`
      );
    return tips;
  }
};

// packages/core/src/utils/is-tool.ts
init_esbuild_shims();
function isTool(obj) {
  return typeof obj === "object" && obj !== null && "name" in obj && "build" in obj && typeof obj.build === "function";
}
__name(isTool, "isTool");

// packages/core/src/tools/tools.ts
var BaseToolInvocation = class {
  constructor(params) {
    this.params = params;
  }
  static {
    __name(this, "BaseToolInvocation");
  }
  toolLocations() {
    return [];
  }
  /**
   * Default: read-only tools return 'allow'. Override in subclasses for
   * tools with side effects.
   */
  getDefaultPermission() {
    return Promise.resolve("allow");
  }
  requiresUserInteraction() {
    return false;
  }
  canAutoApproveOnAllow() {
    return true;
  }
  /**
   * Default fallback: returns a generic 'info' confirmation dialog using the
   * tool's getDescription(). This ensures that even tools whose
   * getDefaultPermission() returns 'allow' can still be prompted when PM
   * rules override the decision to 'ask' at L4.
   *
   * Tools with richer confirmation UIs (Shell, Edit, MCP, etc.) override this.
   */
  getConfirmationDetails(_abortSignal) {
    const details = {
      type: "info",
      title: `Confirm ${this.constructor.name.replace(/Invocation$/, "")}`,
      prompt: this.getDescription(),
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
    return Promise.resolve(details);
  }
};
var DeclarativeTool = class {
  constructor(name, displayName, description, kind, parameterSchema, isOutputMarkdown = true, canUpdateOutput = false, shouldDefer = false, alwaysLoad = false, searchHint) {
    this.name = name;
    this.displayName = displayName;
    this.description = description;
    this.kind = kind;
    this.parameterSchema = parameterSchema;
    this.isOutputMarkdown = isOutputMarkdown;
    this.canUpdateOutput = canUpdateOutput;
    this.shouldDefer = shouldDefer;
    this.alwaysLoad = alwaysLoad;
    this.searchHint = searchHint;
  }
  static {
    __name(this, "DeclarativeTool");
  }
  get schema() {
    return {
      name: this.name,
      description: this.description,
      parametersJsonSchema: this.parameterSchema
    };
  }
  /**
   * Present iff this tool is an omni media-policy tool. A code-level fact
   * of the tool class (not configuration): the scheduler's modelAccess
   * gate, the declaration surfaces, and the fixed-policy orchestrator all
   * key off it. Default: not a media-policy tool.
   */
  get mediaPolicyDescriptor() {
    return void 0;
  }
  /**
   * Max model-facing characters for this tool's output before the scheduler
   * spills it to disk (mirrors Claude Code's per-tool `maxResultSizeChars`).
   *   - `undefined` → use the global truncation threshold.
   *   - `Infinity`  → self-managed (the tool does its own size control, e.g.
   *     ReadFile's line-based paging), exempt from scheduler char truncation.
   * Override in subclasses to opt into a per-tool budget.
   */
  get maxOutputChars() {
    return void 0;
  }
  /**
   * Direction kept when this tool's oversized output is truncated: `'head'`
   * (beginning, e.g. shell), `'tail'` (end, e.g. background agents), or
   * `'both'` (first + last, the default).
   */
  get truncateKeep() {
    return "both";
  }
  /**
   * Projects tool params for the AUTO approval mode classifier.
   *
   * Tools with security-relevant parameters (file paths, shell commands,
   * URLs) should override this to redact voluminous or sensitive fields
   * (full content, secrets) while exposing enough for the classifier to
   * judge safety.
   *
   * Returns:
   *   - object: projected params to send to the classifier
   *   - empty string: signals "no security relevance" — the classifier
   *     transcript will record only the tool name
   *   - undefined: fall back to raw params (only safe when the tool is
   *     known to have no sensitive params)
   *
   * Default is the empty-string sentinel — fail-closed: a tool that has
   * not opted in does not leak its raw parameters (potentially containing
   * API keys, tokens, file contents) into the classifier LLM prompt.
   * Tools that want their args inspected by the classifier for safety
   * judgement should override this and return an object with only the
   * security-relevant fields. Note that `DiscoveredMCPTool` overrides
   * this and forwards a bounded projection of every MCP call's arguments
   * by default (see `mcp-classifier-input.ts`; opt out with
   * `permissions.autoMode.mcp.forwardArguments: false`).
   */
  toAutoClassifierInput(_params) {
    return "";
  }
  /**
   * Validates the raw tool parameters.
   * Subclasses should override this to add custom validation logic
   * beyond the JSON schema check.
   * @param params The raw parameters from the model.
   * @returns An error message string if invalid, null otherwise.
   */
  validateToolParams(_params) {
    return null;
  }
  /**
   * A convenience method that builds and executes the tool in one step.
   * Throws an error if validation fails.
   * @param params The raw, untrusted parameters from the model.
   * @param signal AbortSignal for tool cancellation.
   * @param updateOutput Optional callback to stream output.
   * @returns The result of the tool execution.
   */
  async buildAndExecute(params, signal, updateOutput, shellExecutionConfig) {
    const invocation = this.build(params);
    return invocation.execute(signal, updateOutput, shellExecutionConfig);
  }
  /**
   * Similar to `build` but never throws.
   * @param params The raw, untrusted parameters from the model.
   * @returns A `ToolInvocation` instance.
   */
  silentBuild(params) {
    try {
      return this.build(params);
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }
      return new Error(String(e));
    }
  }
  /**
   * A convenience method that builds and executes the tool in one step.
   * Never throws.
   * @param params The raw, untrusted parameters from the model.
   * @params abortSignal a signal to abort.
   * @returns The result of the tool execution.
   */
  async validateBuildAndExecute(params, abortSignal) {
    const invocationOrError = this.silentBuild(params);
    if (invocationOrError instanceof Error) {
      const errorMessage = invocationOrError.message;
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
        }
      };
    }
    try {
      return await invocationOrError.execute(abortSignal);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error: Tool call execution failed. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: "execution_failed" /* EXECUTION_FAILED */
        }
      };
    }
  }
};
var BaseDeclarativeTool = class extends DeclarativeTool {
  static {
    __name(this, "BaseDeclarativeTool");
  }
  build(params) {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      throw new Error(validationError);
    }
    return this.createInvocation(params);
  }
  validateToolParams(params) {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params
    );
    if (errors) {
      return errors;
    }
    return this.validateToolParamValues(params);
  }
  validateToolParamValues(_params) {
    return null;
  }
};
function hasCycleInSchema(schema) {
  function resolveRef(ref) {
    if (!ref.startsWith("#/")) {
      return null;
    }
    const path = ref.substring(2).split("/");
    let current = schema;
    for (const segment of path) {
      if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, segment)) {
        return null;
      }
      current = current[segment];
    }
    return current;
  }
  __name(resolveRef, "resolveRef");
  function traverse(node, visitedRefs, pathRefs) {
    if (typeof node !== "object" || node === null) {
      return false;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (traverse(item, visitedRefs, pathRefs)) {
          return true;
        }
      }
      return false;
    }
    if ("$ref" in node && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (ref === "#/" || pathRefs.has(ref)) {
        return true;
      }
      if (visitedRefs.has(ref)) {
        return false;
      }
      const resolvedNode = resolveRef(ref);
      if (resolvedNode) {
        visitedRefs.add(ref);
        pathRefs.add(ref);
        const hasCycle = traverse(resolvedNode, visitedRefs, pathRefs);
        pathRefs.delete(ref);
        return hasCycle;
      }
    }
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        if (traverse(
          node[key],
          visitedRefs,
          pathRefs
        )) {
          return true;
        }
      }
    }
    return false;
  }
  __name(traverse, "traverse");
  return traverse(schema, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set());
}
__name(hasCycleInSchema, "hasCycleInSchema");
function isShellProgressData(display) {
  return typeof display === "object" && display !== null && "type" in display && display.type === "shell_progress";
}
__name(isShellProgressData, "isShellProgressData");
var MAX_TERMINAL_IMAGE_BYTES = 8 * 1024 * 1024;
function isTerminalImageDisplay(display) {
  return typeof display === "object" && display !== null && "type" in display && display.type === "terminal_image" && "filePath" in display && typeof display.filePath === "string" && "mimeType" in display && display.mimeType === "image/png";
}
__name(isTerminalImageDisplay, "isTerminalImageDisplay");
var ToolConfirmationOutcome = /* @__PURE__ */ ((ToolConfirmationOutcome2) => {
  ToolConfirmationOutcome2["ProceedOnce"] = "proceed_once";
  ToolConfirmationOutcome2["ProceedOnceAndSwitchToDefault"] = "proceed_once_and_switch_to_default";
  ToolConfirmationOutcome2["ProceedAlways"] = "proceed_always";
  ToolConfirmationOutcome2["ProceedAlwaysServer"] = "proceed_always_server";
  ToolConfirmationOutcome2["ProceedAlwaysTool"] = "proceed_always_tool";
  ToolConfirmationOutcome2["ProceedAlwaysProject"] = "proceed_always_project";
  ToolConfirmationOutcome2["ProceedAlwaysUser"] = "proceed_always_user";
  ToolConfirmationOutcome2["ModifyWithEditor"] = "modify_with_editor";
  ToolConfirmationOutcome2["RestorePrevious"] = "restore_previous";
  ToolConfirmationOutcome2["Cancel"] = "cancel";
  return ToolConfirmationOutcome2;
})(ToolConfirmationOutcome || {});
var CONCURRENCY_SAFE_KINDS = /* @__PURE__ */ new Set([
  "read" /* Read */,
  "search" /* Search */,
  "fetch" /* Fetch */
]);

export {
  StructuredToolError,
  AgentStatistics,
  isTool,
  BaseToolInvocation,
  BaseDeclarativeTool,
  hasCycleInSchema,
  isShellProgressData,
  MAX_TERMINAL_IMAGE_BYTES,
  isTerminalImageDisplay,
  ToolConfirmationOutcome,
  CONCURRENCY_SAFE_KINDS
};
/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
