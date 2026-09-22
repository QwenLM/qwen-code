// Force strict mode and setup for ESM
"use strict";
import {
  AgentEventEmitter,
  MAX_TURN_BUDGET_TOKENS,
  MAX_WORKFLOW_CALL_TRACES,
  attachJsonlTranscriptWriter,
  buildAgentTranscriptAttach,
  canonicalAgentToolName,
  createWorkflowSandbox,
  debugLogger,
  deleteInlineWorkflowScript,
  deriveApprovalModeConfig,
  deriveConfig,
  deriveWorktreeConfig,
  describeAgentToolAllowEntryProblem,
  installSessionWorkflowRevisionWriteThrough,
  isActiveWorkflowStatus,
  isSymlinkedRoot,
  isTerminalWorkflowStatus,
  isWorkflowRunPersistenceActive,
  isWorkflowSizeWarning,
  isWorkflowSourceRef,
  listAgentToolNames,
  narrowAgentTools,
  parseSkillContent,
  readWorkflowSourceRef,
  readWorkflowStepId,
  rebuildToolRegistryOnOverride,
  resolveExternalWorktreeDir,
  toModelVisibleSubagentResult
} from "./chunk-MRTRBONQ.js";
import {
  GitWorktreeService,
  generateAgentWorktreeSlug,
  writeWorktreeSessionMarker
} from "./chunk-KS6F6LZQ.js";
import {
  parsePositiveIntegerEnv
} from "./chunk-6PVPNMXU.js";
import {
  resolveBundleDir
} from "./chunk-ACHCT36C.js";
import {
  SUBAGENT_PLAN_LIFECYCLE_TOOLS
} from "./chunk-B5WYAQ4I.js";
import {
  runWithAgentContext
} from "./chunk-5FHOPPLZ.js";
import {
  read,
  uiTelemetryService,
  writeLine
} from "./chunk-KKGSJZWK.js";
import {
  REASONING_EFFORT_TIERS,
  normalizeReasoningEffort
} from "./chunk-KUON6Z6R.js";
import {
  stripAnsiAndControl
} from "./chunk-B3XJFEEH.js";
import {
  SyntheticOutputTool
} from "./chunk-ZRQGTRHA.js";
import {
  ToolNames,
  resolveBuiltinToolName
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/runtime/workflow-budget.ts
init_esbuild_shims();
var debugLogger2 = createDebugLogger("WORKFLOW_BUDGET");
var MAX_TOKENS_PER_WORKFLOW_ENV = "QWEN_CODE_MAX_TOKENS_PER_WORKFLOW";
var HARD_MAX_TOKENS_CEILING = MAX_TURN_BUDGET_TOKENS;
function resolveMaxTokensPerWorkflow(env = process.env) {
  const raw = env[MAX_TOKENS_PER_WORKFLOW_ENV];
  if (raw === void 0 || raw.trim() === "") {
    return null;
  }
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
    debugLogger2.warn(
      `Invalid ${MAX_TOKENS_PER_WORKFLOW_ENV}=${JSON.stringify(raw)}, treating as unset (no cap)`
    );
    return null;
  }
  if (parsed > HARD_MAX_TOKENS_CEILING) {
    debugLogger2.warn(
      `${MAX_TOKENS_PER_WORKFLOW_ENV}=${parsed} exceeds hard ceiling (${HARD_MAX_TOKENS_CEILING}); clamping.`
    );
    return HARD_MAX_TOKENS_CEILING;
  }
  return parsed;
}
__name(resolveMaxTokensPerWorkflow, "resolveMaxTokensPerWorkflow");
var WorkflowBudgetImpl = class _WorkflowBudgetImpl {
  static {
    __name(this, "WorkflowBudgetImpl");
  }
  total;
  source;
  directiveText;
  turnSpent;
  _runSpent;
  constructor(total, options = {}) {
    this.total = total;
    this.source = total === null ? void 0 : options.source ?? "env";
    this.directiveText = this.source === "directive" ? options.directiveText : void 0;
    this.turnSpent = options.turnSpent;
    this._runSpent = 0;
  }
  /**
   * What the gate and the script measure against `total`: the turn's spend,
   * unless the total is an operator's per-run cap.
   */
  spent() {
    if (this.source !== "env" && this.turnSpent) return this.turnSpent();
    return this._runSpent;
  }
  /** Output tokens this run's own agents reported. */
  runSpent() {
    return this._runSpent;
  }
  /** The cap on this run alone: only an operator's env cap is per run. */
  runCap() {
    return this.source === "env" ? this.total : null;
  }
  remaining() {
    if (this.total === null) return Infinity;
    return Math.max(0, this.total - this.spent());
  }
  /**
   * Host-side increment. NOT exposed to the script — the
   * `WorkflowBudget` interface deliberately omits any setter so a
   * malicious workflow cannot inflate / deflate the budget. Only the
   * production dispatch's `onTokens` callback calls this after a dispatch
   * settles with the agent's output token count.
   *
   * Non-positive deltas are silently dropped (some dispatches return
   * `output_tokens: 0` on early failures); negative deltas would be a
   * caller bug and are also dropped rather than silently rewinding
   * the counter.
   */
  recordSpent(deltaTokens) {
    if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return;
    this._runSpent += deltaTokens;
  }
  /** A per-run budget from the environment alone, with no turn. */
  static fromEnv(env = process.env) {
    return new _WorkflowBudgetImpl(resolveMaxTokensPerWorkflow(env));
  }
  /**
   * The budget for a run launched now: the turn's directive when the current
   * turn set one, else the env cap, else none. The turn is read once — a run
   * that outlives its turn keeps measuring against the turn it started in.
   */
  static fromConfig(config, env = process.env) {
    const sessionId = config.getSessionId?.();
    const turn = sessionId === void 0 ? null : config.getTurnBudget?.()?.current(sessionId) ?? null;
    const turnSpent = turn ? () => Math.max(
      0,
      uiTelemetryService.getTotalOutputTokens(turn.sessionId) - turn.outputTokensAtTurnStart
    ) : void 0;
    if (turn && turn.budget !== null) {
      return new _WorkflowBudgetImpl(turn.budget, {
        source: "directive",
        turnSpent,
        directiveText: turn.directiveText
      });
    }
    const envCap = resolveMaxTokensPerWorkflow(env);
    if (envCap !== null) {
      return new _WorkflowBudgetImpl(envCap, { source: "env" });
    }
    return new _WorkflowBudgetImpl(null, { turnSpent });
  }
};
var WorkflowBudgetExceededError = class extends Error {
  static {
    __name(this, "WorkflowBudgetExceededError");
  }
  name = "WorkflowBudgetExceededError";
  runId;
  budgetTotal;
  spent;
  constructor(runId, budgetTotal, spent) {
    super(
      `Workflow ${runId}: token budget exceeded (${spent} / ${budgetTotal} output tokens). Stopping further agent() calls.`
    );
    this.runId = runId;
    this.budgetTotal = budgetTotal;
    this.spent = spent;
  }
};

// packages/core/src/agents/runtime/workflow-orchestrator.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";

// packages/core/src/agents/runtime/workflow-agent-failure.ts
init_esbuild_shims();
var WorkflowAgentFailedError = class extends Error {
  static {
    __name(this, "WorkflowAgentFailedError");
  }
  name = "WorkflowAgentFailedError";
  kind;
  terminateMode;
  constructor(message, kind, terminateMode) {
    super(message);
    this.kind = kind;
    this.terminateMode = terminateMode;
  }
};
function isWorkflowAgentFailedError(error) {
  return typeof error === "object" && error !== null && error.name === "WorkflowAgentFailedError";
}
__name(isWorkflowAgentFailedError, "isWorkflowAgentFailedError");
var WorkflowAgentCapExceededError = class extends Error {
  static {
    __name(this, "WorkflowAgentCapExceededError");
  }
  name = "WorkflowAgentCapExceededError";
  constructor(maxAgents) {
    super(
      `Workflow exceeded the maximum of ${maxAgents} agent() calls per run. This usually means a loop using budget.remaining() never terminates because no token budget was set \u2014 remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`
    );
  }
};
function isWorkflowRunLevelError(error) {
  if (typeof error !== "object" || error === null) return false;
  const name = error.name;
  return name === "WorkflowBudgetExceededError" || name === "WorkflowAgentCapExceededError";
}
__name(isWorkflowRunLevelError, "isWorkflowRunLevelError");
var WORKFLOW_ABORT_REASON_STALLED = "stalled";

// packages/core/src/agents/runtime/workflow-stall.ts
init_esbuild_shims();
var DEFAULT_STALL_MS = 18e4;
var MAX_STALL_ATTEMPTS = 3;
var MAX_WORKFLOW_STALL_MS_ENV = "QWEN_CODE_WORKFLOW_STALL_SECONDS";
function resolveStallMs(perCall, env = process.env) {
  if (typeof perCall === "number" && Number.isFinite(perCall)) {
    if (perCall === 0) return 0;
    if (perCall > 0) return perCall;
  }
  const raw = env[MAX_WORKFLOW_STALL_MS_ENV];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed === "0") return 0;
    const sec = parsePositiveIntegerEnv(trimmed, 0);
    if (sec > 0) return sec * 1e3;
  }
  return DEFAULT_STALL_MS;
}
__name(resolveStallMs, "resolveStallMs");
var debugLogger3 = createDebugLogger("WORKFLOW_STALL");
function attachStallWatchdog(emitter, controller, stallMs) {
  if (stallMs <= 0) {
    return { stalled: /* @__PURE__ */ __name(() => false, "stalled"), dispose: /* @__PURE__ */ __name(() => {
    }, "dispose") };
  }
  let inFlightTools = 0;
  let fired = false;
  let timer;
  let disposed = false;
  const clear = /* @__PURE__ */ __name(() => {
    if (timer) {
      clearTimeout(timer);
      timer = void 0;
    }
  }, "clear");
  const arm = /* @__PURE__ */ __name(() => {
    clear();
    if (disposed || fired) return;
    if (inFlightTools > 0) return;
    timer = setTimeout(() => {
      if (disposed || fired) return;
      fired = true;
      debugLogger3.warn(
        `[Workflow] agent dispatch stalled \u2014 no progress for ${stallMs}ms; aborting.`
      );
      try {
        controller.abort(WORKFLOW_ABORT_REASON_STALLED);
      } catch (e) {
        debugLogger3.warn("stall watchdog abort threw:", e);
      }
    }, stallMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }, "arm");
  const onActivity = /* @__PURE__ */ __name(() => arm(), "onActivity");
  const onToolCall = /* @__PURE__ */ __name(() => {
    inFlightTools += 1;
    clear();
  }, "onToolCall");
  const onToolResult = /* @__PURE__ */ __name(() => {
    inFlightTools = Math.max(0, inFlightTools - 1);
    arm();
  }, "onToolResult");
  emitter.on("round_start" /* ROUND_START */, onActivity);
  emitter.on("round_end" /* ROUND_END */, onActivity);
  emitter.on("stream_text" /* STREAM_TEXT */, onActivity);
  emitter.on("usage_metadata" /* USAGE_METADATA */, onActivity);
  emitter.on("tool_call" /* TOOL_CALL */, onToolCall);
  emitter.on("tool_result" /* TOOL_RESULT */, onToolResult);
  return {
    stalled: /* @__PURE__ */ __name(() => fired, "stalled"),
    dispose: /* @__PURE__ */ __name(() => {
      if (disposed) return;
      disposed = true;
      clear();
      emitter.off("round_start" /* ROUND_START */, onActivity);
      emitter.off("round_end" /* ROUND_END */, onActivity);
      emitter.off("stream_text" /* STREAM_TEXT */, onActivity);
      emitter.off("usage_metadata" /* USAGE_METADATA */, onActivity);
      emitter.off("tool_call" /* TOOL_CALL */, onToolCall);
      emitter.off("tool_result" /* TOOL_RESULT */, onToolResult);
    }, "dispose")
  };
}
__name(attachStallWatchdog, "attachStallWatchdog");
async function runStallResilient(attemptFn, opts) {
  const { stallMs, signal, label } = opts;
  if (stallMs <= 0) {
    const emitter = new AgentEventEmitter();
    return attemptFn(signal ?? new AbortController().signal, emitter);
  }
  let attempt = 0;
  for (; ; ) {
    attempt += 1;
    const controller = new AbortController();
    let onParentAbort;
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        onParentAbort = /* @__PURE__ */ __name(() => controller.abort(signal.reason), "onParentAbort");
        signal.addEventListener("abort", onParentAbort);
      }
    }
    const emitter = new AgentEventEmitter();
    const watchdog = attachStallWatchdog(emitter, controller, stallMs);
    try {
      return await attemptFn(controller.signal, emitter);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (watchdog.stalled() && attempt < MAX_STALL_ATTEMPTS) {
        debugLogger3.warn(
          `[Workflow] agent "${label ?? "workflow-agent"}" stalled (attempt ${attempt}/${MAX_STALL_ATTEMPTS}) \u2014 retrying.`
        );
        continue;
      }
      if (watchdog.stalled()) {
        throw new WorkflowAgentFailedError(
          `agent "${label ?? "workflow-agent"}" stalled on all ${MAX_STALL_ATTEMPTS} attempts (no progress for ${stallMs}ms each).`,
          "stalled"
        );
      }
      throw err;
    } finally {
      watchdog.dispose();
      if (onParentAbort && signal) {
        signal.removeEventListener("abort", onParentAbort);
      }
    }
  }
}
__name(runStallResilient, "runStallResilient");

// packages/core/src/agents/runtime/workflow-journal.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
var debugLogger4 = createDebugLogger("WORKFLOW_JOURNAL");
var JOURNAL_KEY_VERSION = "v2";
var DISPATCH_AFFECTING_AGENT_OPTS = [
  "schema",
  "model",
  "effort",
  "isolation",
  "agentType",
  "workingDir",
  "disallowedTools",
  "tools"
];
function canonicalizeAgentOpts(opts) {
  const projected = {};
  for (const k of DISPATCH_AFFECTING_AGENT_OPTS) {
    const v = opts[k];
    if (v === void 0 || typeof v === "function") continue;
    projected[k] = v;
  }
  const sortDeep = /* @__PURE__ */ __name((val) => {
    if (typeof val === "function") return void 0;
    if (Array.isArray(val)) return val.map(sortDeep);
    if (val && typeof val === "object") {
      const out = {};
      for (const key of Object.keys(val).sort()) {
        if (key === "__proto__") continue;
        out[key] = sortDeep(val[key]);
      }
      return out;
    }
    return val;
  }, "sortDeep");
  try {
    return JSON.stringify(sortDeep(projected));
  } catch {
    return "{}";
  }
}
__name(canonicalizeAgentOpts, "canonicalizeAgentOpts");
function deriveAgentKey(prefixHash, prompt, opts) {
  const hash = createHash("sha256");
  hash.update(prefixHash);
  hash.update("\0");
  hash.update(prompt);
  hash.update("\0");
  hash.update(canonicalizeAgentOpts(opts));
  return `${JOURNAL_KEY_VERSION}:${hash.digest("hex")}`;
}
__name(deriveAgentKey, "deriveAgentKey");
function deriveArgsSeed(args) {
  const hash = createHash("sha256");
  let serialized;
  try {
    serialized = JSON.stringify(args ?? null) ?? "null";
  } catch {
    serialized = "non-serializable-args";
  }
  hash.update(serialized);
  return `${JOURNAL_KEY_VERSION}:${hash.digest("hex")}`;
}
__name(deriveArgsSeed, "deriveArgsSeed");
function buildReplay(entries) {
  let sourceRef;
  let sourceError;
  const results = /* @__PURE__ */ new Map();
  const started = /* @__PURE__ */ new Map();
  const failed = /* @__PURE__ */ new Set();
  for (const e of entries) {
    if (e.type === "result") {
      results.set(e.key, e);
    } else if (e.type === "started") {
      failed.delete(e.key);
      const list = started.get(e.key);
      if (list) list.push(e);
      else started.set(e.key, [e]);
    } else if (e.type === "failed") {
      failed.add(e.key);
    } else if (e.type === "source") {
      try {
        const ref = readWorkflowSourceRef(e.sourceRef);
        if (e.version !== 1 || !ref || sourceRef && (sourceRef.id !== ref.id || sourceRef.revision !== ref.revision)) {
          throw new Error("Conflicting or unsupported workflow source record.");
        }
        sourceRef = ref;
      } catch {
        sourceError = "Workflow journal contains invalid source metadata.";
      }
    }
  }
  return {
    results,
    started,
    failed,
    ...sourceRef ? { sourceRef } : {},
    ...sourceError ? { sourceError } : {}
  };
}
__name(buildReplay, "buildReplay");
var WorkflowJournal = class {
  constructor(journalPath, root = path.dirname(path.dirname(journalPath))) {
    this.root = root;
    this.path = journalPath;
  }
  static {
    __name(this, "WorkflowJournal");
  }
  pending = Promise.resolve();
  path;
  async hasSymlinkedPath() {
    if (await isSymlinkedRoot(this.root) || await isSymlinkedRoot(path.dirname(this.path))) {
      return true;
    }
    return fs.lstat(this.path).then((stat) => stat.isSymbolicLink()).catch(() => false);
  }
  /** Ensure the advertised journal path exists without affecting the run. */
  async ensureExists() {
    try {
      if (await this.hasSymlinkedPath()) return false;
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      if (await this.hasSymlinkedPath()) return false;
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const file = await fs.open(
        this.path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
        384
      );
      try {
        await file.chmod(384);
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      debugLogger4.warn(
        `WorkflowJournal.ensureExists failed for ${this.path}: ${error}`
      );
      return false;
    }
  }
  /** Remove a never-registered run's journal file, best-effort. */
  async remove() {
    try {
      if (await this.hasSymlinkedPath()) return;
      await fs.rm(this.path, { force: true });
      await fs.rmdir(path.dirname(this.path)).catch((error) => {
        const code = error.code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
      });
    } catch (error) {
      debugLogger4.warn(
        `WorkflowJournal.remove failed for ${this.path}: ${error}`
      );
    }
  }
  /** Load + parse all entries into replay maps. Empty maps if no file. */
  async load() {
    try {
      const entries = await read(this.path);
      return buildReplay(entries);
    } catch (e) {
      debugLogger4.warn(`WorkflowJournal.load failed for ${this.path}: ${e}`);
      return { results: /* @__PURE__ */ new Map(), started: /* @__PURE__ */ new Map(), failed: /* @__PURE__ */ new Set() };
    }
  }
  /** Append one entry. Rejects only on I/O error (callers `.catch`). */
  append(entry) {
    const operation = this.pending.then(() => writeLine(this.path, entry));
    this.pending = operation.catch(() => void 0);
    return operation;
  }
  /** Wait until every append issued so far has settled. */
  drain() {
    return this.pending;
  }
};

// packages/core/src/agents/runtime/workflow-prompts.ts
init_esbuild_shims();
var WORKFLOW_SUBAGENT_SYSTEM_PROMPT = 'You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\nCRITICAL: Your final text response is returned **verbatim** as a string to the calling script \u2014 it is your return value, not a message to a human.\n- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."\n- If asked for JSON, return ONLY the raw JSON \u2014 no code fences, no prose, no markdown.\n- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.\n- Be concise. The script will parse your output.';
var WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA = "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.\nCRITICAL: You MUST deliver your final answer by calling the `structured_output` tool with arguments that conform to its parameter schema. Plain-text final answers are DISCARDED \u2014 only a valid `structured_output` call returns a result to the calling script.\n- Use other tools (Read, Grep, etc.) to gather information first.\n- When ready, call `structured_output` ONCE with the conforming JSON object.\n- If validation fails, the error tells you what to fix. Try again with corrected fields.\n- After two failed attempts, the run terminates \u2014 get the arguments right.\n- Do NOT use SendUserMessage to deliver your answer.\n- Be concise; the script reads only the structured payload, not your prose.";

// packages/core/src/agents/runtime/workflow-dispatch-scheduler.ts
init_esbuild_shims();
function abortError() {
  return new DOMException("Workflow dispatch scheduler aborted.", "AbortError");
}
__name(abortError, "abortError");
var WorkflowDispatchScheduler = class {
  constructor(limit, signal, onStateChange) {
    this.limit = limit;
    this.signal = signal;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Workflow dispatch limit must be a positive integer, got ${String(limit)}.`
      );
    }
    if (onStateChange) this.stateListeners.add(onStateChange);
    if (signal && !signal.aborted) {
      signal.addEventListener("abort", () => this.abortPending(), {
        once: true
      });
    }
  }
  static {
    __name(this, "WorkflowDispatchScheduler");
  }
  state = "running";
  inFlight = 0;
  queue = [];
  gateWaiters = [];
  stateListeners = /* @__PURE__ */ new Set();
  /**
   * Subscribe to state transitions. Returns an unsubscribe function.
   * The constructor callback (when given) is registered as the first
   * listener; this method lets additional observers — e.g. the sandbox's
   * pause-aware wall-clock watchdog — hook the same transitions.
   */
  onStateChange(listener) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  run(thunk) {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(abortError());
        return;
      }
      this.queue.push({
        thunk,
        resolve,
        reject
      });
      this.pump();
    });
  }
  pause() {
    if (this.state !== "running" || this.signal?.aborted) return false;
    this.setState("pausing");
    if (this.inFlight === 0) this.setState("paused");
    return true;
  }
  resume() {
    if (this.state !== "paused" || this.signal?.aborted) return false;
    this.setState("running");
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift().resolve();
    }
    this.pump();
    return true;
  }
  waitUntilRunning() {
    if (this.signal?.aborted) return Promise.reject(abortError());
    if (this.state === "running") return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.gateWaiters.push({ resolve, reject });
    });
  }
  snapshot() {
    return {
      state: this.state,
      queued: this.queue.length,
      inFlight: this.inFlight
    };
  }
  pump() {
    while (this.state === "running" && this.inFlight < this.limit && this.queue.length > 0) {
      const job = this.queue.shift();
      if (this.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      this.inFlight++;
      Promise.resolve().then(job.thunk).then(job.resolve, job.reject).finally(() => {
        this.inFlight--;
        if (this.state === "pausing" && this.inFlight === 0) {
          this.setState("paused");
        }
        this.pump();
      });
    }
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    const snapshot = this.snapshot();
    for (const listener of [...this.stateListeners]) listener(snapshot);
  }
  abortPending() {
    const error = abortError();
    while (this.queue.length > 0) this.queue.shift().reject(error);
    while (this.gateWaiters.length > 0) {
      this.gateWaiters.shift().reject(error);
    }
  }
};

// packages/core/src/agents/runtime/workflow-orchestrator.ts
var DEFAULT_MAX_AGENTS_PER_RUN = 1e3;
var MAX_WORKFLOW_AGENTS_ENV = "QWEN_CODE_MAX_WORKFLOW_AGENTS";
var HARD_MAX_AGENTS_PER_RUN_CEILING = 1e4;
function resolveMaxAgentsPerRun(env = process.env) {
  const raw = env[MAX_WORKFLOW_AGENTS_ENV];
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_AGENTS_ENV}=${JSON.stringify(raw)}, using default (${DEFAULT_MAX_AGENTS_PER_RUN})`
    );
    return DEFAULT_MAX_AGENTS_PER_RUN;
  }
  if (parsed > HARD_MAX_AGENTS_PER_RUN_CEILING) {
    debugLogger.warn(
      `${MAX_WORKFLOW_AGENTS_ENV}=${parsed} exceeds hard ceiling (${HARD_MAX_AGENTS_PER_RUN_CEILING}); clamping.`
    );
    return HARD_MAX_AGENTS_PER_RUN_CEILING;
  }
  return parsed;
}
__name(resolveMaxAgentsPerRun, "resolveMaxAgentsPerRun");
var MAX_WORKFLOW_CONCURRENCY_ENV = "QWEN_CODE_MAX_WORKFLOW_CONCURRENCY";
var HARD_MAX_CONCURRENCY_CEILING = 64;
function resolveConcurrencyLimit(env = process.env, availableParallelism2 = os.availableParallelism) {
  const raw = env[MAX_WORKFLOW_CONCURRENCY_ENV];
  if (raw !== void 0 && raw.trim() !== "") {
    const parsed = parsePositiveIntegerEnv(raw, 0);
    if (parsed >= 1) {
      if (parsed > HARD_MAX_CONCURRENCY_CEILING) {
        debugLogger.warn(
          `${MAX_WORKFLOW_CONCURRENCY_ENV}=${parsed} exceeds hard ceiling (${HARD_MAX_CONCURRENCY_CEILING}); clamping.`
        );
        return HARD_MAX_CONCURRENCY_CEILING;
      }
      return parsed;
    }
    debugLogger.warn(
      `Invalid ${MAX_WORKFLOW_CONCURRENCY_ENV}=${JSON.stringify(raw)}, using cpu-derived default`
    );
  }
  return Math.max(2, Math.min(16, availableParallelism2() - 2));
}
__name(resolveConcurrencyLimit, "resolveConcurrencyLimit");
var DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS = 50;
var DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES = 10;
var WORKFLOW_SUBAGENT_MAX_TURNS_ENV = "QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS";
var WORKFLOW_SUBAGENT_MAX_MINUTES_ENV = "QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES";
var HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING = 500;
var HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING = 100;
function resolveSubagentBound(envName, defaultValue, ceiling, env) {
  const raw = env[envName];
  if (raw === void 0 || raw.trim() === "") return defaultValue;
  const parsed = parsePositiveIntegerEnv(raw, 0);
  if (parsed < 1) {
    debugLogger.warn(
      `Invalid ${envName}=${JSON.stringify(raw)}, using default (${defaultValue})`
    );
    return defaultValue;
  }
  if (parsed > ceiling) {
    debugLogger.warn(
      `${envName}=${parsed} exceeds hard ceiling (${ceiling}); clamping.`
    );
    return ceiling;
  }
  return parsed;
}
__name(resolveSubagentBound, "resolveSubagentBound");
function resolveSubagentMaxTurns(env = process.env, defaultValue = DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS) {
  return resolveSubagentBound(
    WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
    defaultValue,
    HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING,
    env
  );
}
__name(resolveSubagentMaxTurns, "resolveSubagentMaxTurns");
function resolveSubagentMaxTimeMinutes(env = process.env, defaultValue = DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES) {
  return resolveSubagentBound(
    WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
    defaultValue,
    HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING,
    env
  );
}
__name(resolveSubagentMaxTimeMinutes, "resolveSubagentMaxTimeMinutes");
var WORKFLOW_SUBAGENT_DISALLOWED_TOOLS = [
  ToolNames.ASK_USER_QUESTION,
  ToolNames.SEND_MESSAGE,
  ToolNames.MONITOR,
  ...SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  // AgentTool: workflow subagents must not spawn sub-agents even where
  // maxSubagentDepth would permit nesting — a leaf-spawned agent would run
  // outside the orchestrator's concurrency cap, agent counter, and token
  // budget, and its result would bypass the script's return-value contract.
  // The WorkflowTool itself is already excluded from every subagent; this
  // closes the same loop for plain `agent` calls (review #6189).
  ToolNames.AGENT
];
var WorkflowExecutionError = class extends Error {
  constructor(message, phases, logs, meta = null) {
    super(message);
    this.phases = phases;
    this.logs = logs;
    this.meta = meta;
  }
  static {
    __name(this, "WorkflowExecutionError");
  }
  name = "WorkflowExecutionError";
};
function runBudgetFigures(budget) {
  return [
    budget.runSpent ? budget.runSpent() : budget.spent(),
    budget.runCap ? budget.runCap() : budget.total
  ];
}
__name(runBudgetFigures, "runBudgetFigures");
function generateRunId() {
  return `wf_${randomBytes(8).toString("hex")}`;
}
__name(generateRunId, "generateRunId");
function sanitizeForErrorMessage(value) {
  return stripAnsiAndControl(value);
}
__name(sanitizeForErrorMessage, "sanitizeForErrorMessage");
function createProductionDispatch(config, signal, onTokens, bridgeApprovalEvents, subagentBounds) {
  return async (prompt, opts, dispatchId) => {
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("agent() requires a non-empty string prompt.");
    }
    const stallMs = resolveStallMs(
      typeof opts.stallMs === "number" ? opts.stallMs : void 0
    );
    const workflowAgentId = `workflow-agent-${randomBytes(8).toString("hex")}`;
    const agentIdentity = await resolveWorkflowAgentIdentity(config, opts);
    if (agentIdentity.resolvedAgentType?.executor !== void 0) {
      throw new Error(
        "Workflow agent() does not support external-executor agents: token budgets, schema output, and workflow tool restrictions cannot be enforced. Use an in-process agent definition instead."
      );
    }
    let attempt = 0;
    return runStallResilient(
      async (attemptSignal, emitter) => {
        attempt += 1;
        const cleanupApprovalBridge = bridgeApprovalEvents?.(
          emitter,
          dispatchId
        );
        const cleanupTranscript = attachDispatchTranscript(
          config,
          workflowAgentId,
          prompt,
          agentIdentity.name,
          emitter,
          attempt
        );
        try {
          return await runSingleDispatch(
            config,
            prompt,
            opts,
            attemptSignal,
            emitter,
            workflowAgentId,
            agentIdentity,
            onTokens,
            subagentBounds
          );
        } finally {
          cleanupTranscript();
          cleanupApprovalBridge?.();
        }
      },
      {
        stallMs,
        signal,
        // The name can carry a model-authored agentType spelling — keep
        // the stall log / abandoned error single-line the same way the
        // "not found" throw site sanitizes it.
        label: sanitizeForErrorMessage(agentIdentity.name)
      }
    );
  };
}
__name(createProductionDispatch, "createProductionDispatch");
async function resolveWorkflowAgentIdentity(config, opts) {
  if (opts.agentType) {
    const resolved = await config.getSubagentManager().findSubagentByName(opts.agentType);
    if (resolved) {
      return { name: resolved.name, resolvedAgentType: resolved };
    }
  }
  if (typeof opts.label === "string" && opts.label) {
    return { name: opts.label };
  }
  return { name: opts.agentType || "workflow-agent" };
}
__name(resolveWorkflowAgentIdentity, "resolveWorkflowAgentIdentity");
function attachDispatchTranscript(config, agentId, prompt, agentName, emitter, attempt) {
  const append = attempt > 1;
  try {
    const { jsonlPath, options } = buildAgentTranscriptAttach(config, agentId, {
      agentName,
      // The prompt the SCRIPT dispatched, seeded as the transcript's first
      // user record — the same shape AgentTool writes, so a reader that
      // recovers a launch prompt from a transcript needs no workflow-
      // specific branch. A retry re-uses the first attempt's record rather
      // than seeding a second one.
      initialUserPrompt: append ? void 0 : prompt,
      appendToExisting: append,
      retryAttempt: append ? attempt : void 0
    });
    return attachJsonlTranscriptWriter(emitter, jsonlPath, options).cleanup;
  } catch (error) {
    debugLogger.warn(
      `[Workflow] failed to attach transcript for ${agentId}: ${error}`
    );
    return () => {
    };
  }
}
__name(attachDispatchTranscript, "attachDispatchTranscript");
function terminalDispatchError(workflowAgentId, mode) {
  const message = `Workflow subagent ${workflowAgentId} did not complete (terminate mode: ${mode}).`;
  switch (mode) {
    case "MAX_TURNS" /* MAX_TURNS */:
      return new WorkflowAgentFailedError(message, "max_turns", mode);
    case "TIMEOUT" /* TIMEOUT */:
      return new WorkflowAgentFailedError(message, "timeout", mode);
    case "ERROR" /* ERROR */:
      return new WorkflowAgentFailedError(message, "error", mode);
    default:
      return new Error(message);
  }
}
__name(terminalDispatchError, "terminalDispatchError");
async function runSingleDispatch(config, prompt, opts, attemptSignal, emitter, workflowAgentId, agentIdentity, onTokens, subagentBounds) {
  const { AgentHeadless, ContextState } = await import("./agent-headless-AQI2VLYW.js");
  const ctx = new ContextState();
  ctx.set("task_prompt", prompt);
  debugLogger.debug(`[workflow] Dispatch ${workflowAgentId}`);
  if (DISPATCH_AFFECTING_AGENT_OPTS.every((key) => opts[key] === void 0)) {
    const subagent = await AgentHeadless.create(
      agentIdentity.name,
      config,
      {
        systemPrompt: WORKFLOW_SUBAGENT_SYSTEM_PROMPT
      },
      {},
      // T11 (PR #4732 R1): bound resource ceiling so a single agent() call
      // cannot loop the model indefinitely. Without this, runConfig was {}
      // and the loop guards never tripped — combined with the cancellation
      // bug below, workflows were effectively unkillable.
      subagentBounds ?? {
        max_turns: resolveSubagentMaxTurns(),
        max_time_minutes: resolveSubagentMaxTimeMinutes()
      },
      // T11 (PR #4732 R1): disallow SendMessage / ExitPlanMode to align with
      // upstream Tg8 — closes the back-channel that would let a subagent
      // deliver its answer via user message instead of the script's read.
      { tools: ["*"], disallowedTools: WORKFLOW_SUBAGENT_DISALLOWED_TOOLS },
      // P-stall: the stall-watchdog emitter observes reasoning-loop events
      // (round/tool/usage) to detect a hang and abort `attemptSignal`.
      emitter,
      void 0,
      void 0,
      prompt,
      workflowAgentId
    );
    try {
      await runWithAgentContext(
        workflowAgentId,
        () => subagent.execute(ctx, attemptSignal)
      );
    } finally {
      reportTokens(subagent, opts, onTokens);
    }
    const mode = subagent.getTerminateMode();
    if (mode !== "GOAL" /* GOAL */) {
      throw terminalDispatchError(workflowAgentId, mode);
    }
    return toModelVisibleSubagentResult(subagent.getFinalText(), mode);
  }
  return runOverridePath(
    config,
    ctx,
    opts,
    attemptSignal,
    workflowAgentId,
    agentIdentity,
    onTokens,
    emitter,
    subagentBounds
  );
}
__name(runSingleDispatch, "runSingleDispatch");
function reportTokens(subagent, opts, onTokens) {
  if (!onTokens) return;
  try {
    const summary = subagent.getExecutionSummary();
    onTokens(summary.outputTokens, opts);
  } catch (e) {
    debugLogger.warn("onTokens callback threw:", e);
  }
}
__name(reportTokens, "reportTokens");
function resolveDispatchEffort(raw) {
  if (raw === void 0) return void 0;
  const tier = typeof raw === "string" ? normalizeReasoningEffort(raw) : void 0;
  if (tier === void 0) {
    throw new Error(
      `agent({effort}): unknown effort tier ${sanitizeForErrorMessage(
        JSON.stringify(raw) ?? String(raw)
      )}. Known tiers are: ${REASONING_EFFORT_TIERS.join(", ")}.`
    );
  }
  return tier;
}
__name(resolveDispatchEffort, "resolveDispatchEffort");
function resolveDispatchDenies(raw) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw) || raw.some(
    (name) => typeof name !== "string" || name.length === 0 || name !== name.trim()
  )) {
    throw new Error(
      "agent({disallowedTools}): must be an array of non-empty tool-name strings without surrounding whitespace, e.g. ['run_shell_command', 'write_file']."
    );
  }
  return raw.map((name) => resolveBuiltinToolName(name) ?? name);
}
__name(resolveDispatchDenies, "resolveDispatchDenies");
function resolveDispatchAllows(raw) {
  if (raw === void 0) return void 0;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(
    (name) => typeof name !== "string" || name.length === 0 || name !== name.trim()
  )) {
    throw new Error(
      "agent({tools}): must be a non-empty array of tool-name strings without surrounding whitespace, e.g. ['run_shell_command', 'read_file']. Omit tools to keep every tool."
    );
  }
  for (const name of raw) {
    const problem = describeAgentToolAllowEntryProblem(name);
    if (problem !== null) {
      throw new Error(`agent({tools}): ${sanitizeForErrorMessage(problem)}`);
    }
  }
  return [...new Set(raw.map(canonicalAgentToolName))];
}
__name(resolveDispatchAllows, "resolveDispatchAllows");
async function runOverridePath(config, ctx, opts, signal, workflowAgentId, agentIdentity, onTokens, emitter, subagentBounds) {
  if (opts.isolation === "remote") {
    throw new Error(
      "agent({isolation:'remote'}) is not available in this build."
    );
  }
  const effort = resolveDispatchEffort(opts.effort);
  const requestedDenies = resolveDispatchDenies(opts.disallowedTools);
  const requestedAllows = resolveDispatchAllows(opts.tools);
  const subagentMgr = config.getSubagentManager();
  let baseConfig;
  if (opts.agentType !== void 0) {
    const resolved = agentIdentity.resolvedAgentType;
    if (!resolved) {
      const safeAgentType = sanitizeForErrorMessage(opts.agentType);
      throw new Error(
        `agent({agentType}): agent type '${safeAgentType}' not found.`
      );
    }
    baseConfig = resolved;
  } else {
    baseConfig = {
      name: agentIdentity.name,
      description: "Default workflow subagent (per-call overrides).",
      systemPrompt: WORKFLOW_SUBAGENT_SYSTEM_PROMPT,
      level: "session",
      isBuiltin: false
    };
  }
  let schemaSystemPrompt;
  if (opts.schema !== void 0) {
    schemaSystemPrompt = opts.agentType !== void 0 && baseConfig.systemPrompt ? `${baseConfig.systemPrompt}

${WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA}` : WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA;
  }
  let schemaTools;
  if (opts.schema !== void 0 && baseConfig.tools && baseConfig.tools.length > 0 && !baseConfig.tools.includes("*") && !baseConfig.tools.includes(ToolNames.STRUCTURED_OUTPUT)) {
    schemaTools = [...baseConfig.tools, ToolNames.STRUCTURED_OUTPUT];
  }
  const augmented = {
    ...baseConfig,
    ...opts.model !== void 0 ? { model: opts.model } : {},
    ...schemaSystemPrompt !== void 0 ? { systemPrompt: schemaSystemPrompt } : {},
    ...schemaTools !== void 0 ? { tools: schemaTools } : {},
    disallowedTools: Array.from(
      /* @__PURE__ */ new Set([
        ...baseConfig.disallowedTools ?? [],
        ...WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
        ...requestedDenies
      ])
    )
  };
  if (requestedDenies.length > 0) {
    const unmatched = await subagentMgr.findUnmatchedToolNames(requestedDenies);
    if (unmatched.length > 0) {
      throw new Error(
        `agent({disallowedTools}): ${sanitizeForErrorMessage(
          unmatched.map((name) => JSON.stringify(name)).join(", ")
        )} ${unmatched.length === 1 ? "matches" : "match"} no tool. Use a tool name (run_shell_command, write_file, edit), a display name (Shell, WriteFile, Edit), or an MCP pattern (mcp__<server>, mcp__<server>__*, mcp__<server>__<tool>).`
      );
    }
  }
  if (opts.schema !== void 0 && [...baseConfig.disallowedTools ?? [], ...requestedDenies].some(
    (name) => (resolveBuiltinToolName(name) ?? name) === ToolNames.STRUCTURED_OUTPUT
  )) {
    throw new Error(
      "agent({schema, disallowedTools}): schema mode needs the structured_output tool, but disallowedTools deny it (from this call or from the agent type)."
    );
  }
  if (requestedAllows !== void 0) {
    const agentHasOwnMcpServers = baseConfig.mcpServers !== void 0 && Object.keys(baseConfig.mcpServers).length > 0;
    const checkMcpNames = !agentHasOwnMcpServers;
    if (requestedAllows.some(
      (name) => resolveBuiltinToolName(name) === void 0 && (checkMcpNames || !name.startsWith("mcp__"))
    )) {
      await config.waitForMcpReady();
    }
    const unmatchedAllows = await subagentMgr.findUnmatchedToolNames(
      requestedAllows,
      { checkMcpNames }
    );
    if (unmatchedAllows.length > 0) {
      throw new Error(
        `agent({tools}): ${sanitizeForErrorMessage(
          listAgentToolNames(unmatchedAllows)
        )} ${unmatchedAllows.length === 1 ? "names" : "name"} no tool. Use a tool name (run_shell_command, read_file), a display name (Shell, ReadFile), or an MCP tool's exact name as the model sees it (mcp__<server>__<tool>).`
      );
    }
    const agentTypeTools = baseConfig.tools !== void 0 && baseConfig.tools.length > 0 && !baseConfig.tools.includes("*") ? baseConfig.tools : void 0;
    try {
      augmented.tools = narrowAgentTools({
        requested: requestedAllows,
        requestedNames: await subagentMgr.resolveToolNames(requestedAllows),
        ...agentTypeTools !== void 0 ? {
          agentTypeTools,
          agentTypeToolNames: await subagentMgr.resolveToolNames(agentTypeTools)
        } : {},
        denies: await subagentMgr.resolveToolNames(
          augmented.disallowedTools ?? []
        ),
        schema: opts.schema !== void 0
      });
    } catch (error) {
      throw new Error(
        sanitizeForErrorMessage(
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }
  let worktreeIsolation = null;
  let effectiveContext = config;
  let approvalCleanup;
  if (opts.isolation !== void 0 && opts.workingDir !== void 0) {
    throw new Error(
      "agent({workingDir, isolation}): incompatible options. workingDir pins the agent to a worktree you already own; isolation creates a fresh one and removes it afterwards. Pass one."
    );
  }
  if (opts.isolation === "worktree") {
    worktreeIsolation = await provisionWorkflowWorktree(config);
    effectiveContext = deriveWorktreeConfig(config, worktreeIsolation.path, {
      customIgnoreFiles: config.getFileFilteringOptions().customIgnoreFiles
    });
    installSessionWorkflowRevisionWriteThrough(effectiveContext, config);
  } else if (opts.workingDir !== void 0) {
    if (typeof opts.workingDir !== "string" || opts.workingDir.trim().length === 0) {
      throw new Error(
        "agent({workingDir}): must be a non-empty string naming an existing git worktree of this repository."
      );
    }
    const resolved = await resolveExternalWorktreeDir(
      config,
      opts.workingDir,
      "workingDir"
    );
    if ("error" in resolved) {
      throw new Error(
        `agent({workingDir: ${sanitizeForErrorMessage(JSON.stringify(opts.workingDir))}}): ${sanitizeForErrorMessage(resolved.error)}`
      );
    }
    effectiveContext = deriveWorktreeConfig(config, resolved.path, {
      customIgnoreFiles: config.getFileFilteringOptions().customIgnoreFiles
    });
    installSessionWorkflowRevisionWriteThrough(effectiveContext, config);
  }
  if (effectiveContext !== config) {
    const approvalHandle = deriveApprovalModeConfig(
      effectiveContext,
      config.getApprovalMode()
    );
    approvalCleanup = approvalHandle.cleanup;
    effectiveContext = approvalHandle.config;
  }
  let onParentAbort;
  try {
    let schemaState = null;
    if (opts.schema !== void 0) {
      effectiveContext = await createSchemaConfigOverride(
        effectiveContext,
        opts.schema
      );
      schemaState = createSchemaModeState();
    }
    let dispatchSignal = signal;
    if (schemaState) {
      const child = new AbortController();
      if (signal) {
        if (signal.aborted) {
          child.abort(signal.reason);
        } else {
          onParentAbort = /* @__PURE__ */ __name(() => child.abort(signal.reason), "onParentAbort");
          signal.addEventListener("abort", onParentAbort);
        }
      }
      schemaState.abortController = child;
      dispatchSignal = child.signal;
    }
    const eventEmitter = emitter ?? (schemaState ? new AgentEventEmitter() : void 0);
    if (schemaState && eventEmitter) {
      attachSchemaListeners(eventEmitter, schemaState);
    }
    const { subagent, dispose } = await subagentMgr.createAgentHeadless(
      augmented,
      effectiveContext,
      {
        // Workflow always bounds resource ceiling regardless of agentType's
        // own runConfig / maxTurns — these are workflow-level safety bounds,
        // not subagent-level preferences. P5 will refine via budget.
        runConfigOverrides: subagentBounds ?? {
          max_turns: resolveSubagentMaxTurns(),
          max_time_minutes: resolveSubagentMaxTimeMinutes()
        },
        ...effort !== void 0 ? { modelConfigOverrides: { reasoningEffort: effort } } : {},
        eventEmitter,
        taskName: String(ctx.get("task_prompt")),
        subagentId: workflowAgentId
      }
    );
    try {
      try {
        await runWithAgentContext(
          workflowAgentId,
          () => subagent.execute(ctx, dispatchSignal)
        );
      } finally {
        reportTokens(subagent, opts, onTokens);
      }
      if (schemaState) {
        if (schemaState.result !== null) {
          if (worktreeIsolation) {
            const isolation = worktreeIsolation;
            worktreeIsolation = null;
            const preserved = await cleanupWorkflowWorktree(isolation);
            if (preserved) {
              debugLogger.info(
                `[Workflow] Schema-mode subagent preserved worktree at ${preserved.path ?? "(directory removed)"} on branch ${preserved.branch}. The structured payload is returned verbatim; recover the work from the preserved path / branch.`
              );
            }
          }
          return schemaState.result;
        }
        if (signal?.aborted) {
          throw new DOMException("Workflow aborted.", "AbortError");
        }
        const mode2 = subagent.getTerminateMode();
        if (mode2 !== "GOAL" /* GOAL */ && mode2 !== "CANCELLED" /* CANCELLED */) {
          throw terminalDispatchError(workflowAgentId, mode2);
        }
        if (schemaState.attempts > 2) {
          throw new WorkflowAgentFailedError(
            "subagent completed without calling StructuredOutput (after 2 in-conversation nudges).",
            "no_structured_output"
          );
        }
        throw new WorkflowAgentFailedError(
          "subagent completed without calling structured_output (no validation attempt \u2014 model produced plain-text content).",
          "no_structured_output"
        );
      }
      const mode = subagent.getTerminateMode();
      if (mode !== "GOAL" /* GOAL */) {
        throw terminalDispatchError(workflowAgentId, mode);
      }
      let finalText = toModelVisibleSubagentResult(
        subagent.getFinalText(),
        mode
      );
      if (worktreeIsolation) {
        const isolation = worktreeIsolation;
        worktreeIsolation = null;
        const preserved = await cleanupWorkflowWorktree(isolation);
        if (preserved && typeof finalText === "string") {
          finalText = appendWorktreePreservedSuffix(finalText, preserved);
        }
      }
      return finalText;
    } finally {
      await dispose();
    }
  } finally {
    if (onParentAbort && signal) {
      signal.removeEventListener("abort", onParentAbort);
    }
    approvalCleanup?.();
    if (worktreeIsolation) {
      try {
        await cleanupWorkflowWorktree(worktreeIsolation);
      } catch (error) {
        debugLogger.warn(
          `Workflow worktree cleanup in fallback finally failed for ${worktreeIsolation.path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
__name(runOverridePath, "runOverridePath");
async function provisionWorkflowWorktree(config) {
  const cwd = config.getTargetDir();
  if (/\.qwen[\\/]worktrees[\\/]/.test(cwd)) {
    throw new Error(
      `agent({isolation:'worktree'}): parent is already inside a worktree (${cwd}). Nested isolation worktrees are not supported \u2014 the subagent's inherited paths would still reference the outer worktree.`
    );
  }
  const probe = new GitWorktreeService(cwd);
  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    throw new Error(
      `agent({isolation:'worktree'}): ${gitCheck.error ?? "git is not available"}.`
    );
  }
  if (!await probe.isGitRepository()) {
    throw new Error(
      `agent({isolation:'worktree'}): ${cwd} is not a git repository.`
    );
  }
  const projectRoot = await probe.getRepoTopLevel() ?? cwd;
  const wtService = projectRoot === cwd ? probe : new GitWorktreeService(projectRoot);
  let parentDirty = false;
  try {
    parentDirty = await wtService.hasWorktreeChanges(projectRoot);
  } catch (error) {
    debugLogger.warn(
      `[Workflow] hasWorktreeChanges failed at ${projectRoot}: ${error}`
    );
    parentDirty = true;
  }
  if (parentDirty) {
    throw new Error(
      `agent({isolation:'worktree'}): parent working tree at ${projectRoot} has uncommitted changes that would not propagate into the isolated worktree. The subagent would see the prior HEAD instead of the current state. Commit or stash the changes, then re-run.`
    );
  }
  const slug = generateAgentWorktreeSlug();
  let parentBranch;
  try {
    parentBranch = await wtService.getCurrentBranch();
  } catch (error) {
    debugLogger.warn(
      `[Workflow] getCurrentBranch failed at ${projectRoot}: ${error}`
    );
  }
  const created = await wtService.createUserWorktree(slug, parentBranch, {
    symlinkDirectories: config.getWorktreeSymlinkDirectories()
  });
  if (!created.success || !created.worktree) {
    throw new Error(
      `agent({isolation:'worktree'}): failed to create worktree: ${created.error ?? "unknown error"}.`
    );
  }
  try {
    await writeWorktreeSessionMarker(
      created.worktree.path,
      config.getSessionId()
    );
  } catch (error) {
    debugLogger.warn(
      `[Workflow] failed to write session marker at ${created.worktree.path}: ${error}`
    );
  }
  return {
    slug,
    path: created.worktree.path,
    branch: created.worktree.branch,
    repoRoot: projectRoot
  };
}
__name(provisionWorkflowWorktree, "provisionWorkflowWorktree");
async function cleanupWorkflowWorktree(isolation) {
  const wtService = new GitWorktreeService(isolation.repoRoot);
  const [hasChanges, hasUnmerged] = await Promise.all([
    wtService.hasWorktreeChanges(isolation.path).catch((error) => {
      debugLogger.warn(
        `[Workflow] hasWorktreeChanges failed for ${isolation.path}: ${error}`
      );
      return true;
    }),
    wtService.hasUnmergedWorktreeCommits(isolation.slug).catch((error) => {
      debugLogger.warn(
        `[Workflow] hasUnmergedWorktreeCommits failed for ${isolation.slug}: ${error}`
      );
      return true;
    })
  ]);
  if (hasChanges || hasUnmerged) {
    debugLogger.info(
      `[Workflow] Preserving isolation worktree ${isolation.path} (branch ${isolation.branch}, hasChanges=${hasChanges}, hasUnmerged=${hasUnmerged})`
    );
    return { path: isolation.path, branch: isolation.branch };
  }
  try {
    const result = await wtService.removeUserWorktree(isolation.slug, {
      deleteBranch: true
    });
    if (!result.success) {
      debugLogger.warn(
        `[Workflow] Failed to remove ephemeral worktree ${isolation.path}: ${result.error}`
      );
      return { path: isolation.path, branch: isolation.branch };
    }
    if (result.branchPreserved) {
      debugLogger.warn(
        `[Workflow] Removed worktree directory ${isolation.path} but kept branch ${isolation.branch} (unmerged commits at delete time)`
      );
      return { branch: isolation.branch };
    }
  } catch (error) {
    debugLogger.warn(
      `[Workflow] Failed to remove ephemeral worktree ${isolation.path}: ${error}`
    );
    return { path: isolation.path, branch: isolation.branch };
  }
  return null;
}
__name(cleanupWorkflowWorktree, "cleanupWorkflowWorktree");
function appendWorktreePreservedSuffix(finalText, preserved) {
  const sep = finalText.endsWith("\n") ? "\n" : "\n\n";
  if (preserved.path) {
    return `${finalText}${sep}[worktree preserved: ${preserved.path} (branch ${preserved.branch})]`;
  }
  return `${finalText}${sep}[worktree directory removed; branch ${preserved.branch} preserved \u2014 recover with \`git worktree add <path> ${preserved.branch}\`]`;
}
__name(appendWorktreePreservedSuffix, "appendWorktreePreservedSuffix");
function createSchemaModeState() {
  return {
    result: null,
    attempts: 0,
    pendingArgs: /* @__PURE__ */ new Map(),
    abortController: new AbortController()
  };
}
__name(createSchemaModeState, "createSchemaModeState");
function attachSchemaListeners(emitter, state) {
  const targetTool = ToolNames.STRUCTURED_OUTPUT;
  emitter.on("tool_call" /* TOOL_CALL */, (evt) => {
    if (evt.name !== targetTool) return;
    state.pendingArgs.set(evt.callId, evt.args);
  });
  emitter.on("tool_result" /* TOOL_RESULT */, (evt) => {
    if (evt.name !== targetTool) return;
    const args = state.pendingArgs.get(evt.callId);
    state.pendingArgs.delete(evt.callId);
    if (evt.success) {
      if (args !== void 0 && state.result === null) {
        state.result = args;
        state.abortController.abort();
      }
      return;
    }
    state.attempts += 1;
    if (state.attempts > 2 && state.result === null) {
      state.abortController.abort();
    }
  });
}
__name(attachSchemaListeners, "attachSchemaListeners");
async function createSchemaConfigOverride(base, schema) {
  const override = deriveConfig(base);
  installSessionWorkflowRevisionWriteThrough(override, base);
  await rebuildToolRegistryOnOverride(override, base);
  const registry = override.getToolRegistry();
  registry.registerTool(new SyntheticOutputTool(schema));
  return override;
}
__name(createSchemaConfigOverride, "createSchemaConfigOverride");
var WorkflowOrchestrator = class {
  constructor(dispatch) {
    this.dispatch = dispatch;
  }
  static {
    __name(this, "WorkflowOrchestrator");
  }
  async run(req) {
    const runId = req.runId ?? generateRunId();
    const maxAgents = resolveMaxAgentsPerRun();
    const signal = req.abortOnTimeout?.signal;
    const scheduler = req.scheduler ?? new WorkflowDispatchScheduler(resolveConcurrencyLimit(), signal);
    const rejectThroughPauseGate = /* @__PURE__ */ __name((error) => scheduler.waitUntilRunning().then(
      () => {
        throw error;
      },
      () => {
        throw error;
      }
    ), "rejectThroughPauseGate");
    let agentCount = 0;
    let dispatchTraceCount = 0;
    const emitter = req.emitter;
    const budget = req.budget;
    const dependencyContext = new AsyncLocalStorage();
    const issueDispatchTrace = /* @__PURE__ */ __name((prompt, opts, cached = false, workflowCallId) => {
      const id = `dispatch-${dispatchTraceCount += 1}`;
      const store = dependencyContext.getStore();
      const dependsOn = Array.from(new Set(store?.tails ?? []));
      if (store) store.tails = [id];
      try {
        emitter?.dispatchQueued?.({
          id,
          ...opts.stepId !== void 0 ? { stepId: opts.stepId } : {},
          ...workflowCallId ? { workflowCallId } : {},
          ...typeof opts.label === "string" ? { label: opts.label } : {},
          prompt,
          dependsOn,
          queuedAt: Date.now(),
          ...cached ? { cached: true } : {}
        });
      } catch (e) {
        debugLogger.warn("emitter.dispatchQueued threw:", e);
      }
      return id;
    }, "issueDispatchTrace");
    const journal = req.journal;
    const replay = req.resumeReplay;
    let prefixHash = deriveArgsSeed(req.args);
    let hadMiss = false;
    let journalAgentId = 0;
    const parentSandboxRef = {
      current: void 0
    };
    const countedDispatch = /* @__PURE__ */ __name((prompt, opts, workflowCallId) => {
      const stepId = readWorkflowStepId(opts.stepId);
      if (stepId !== void 0) opts = { ...opts, stepId };
      if (typeof prompt !== "string" || prompt.length === 0) {
        return rejectThroughPauseGate(
          new Error("agent() requires a non-empty string prompt.")
        );
      }
      let journalKey;
      let journalEntryId;
      let respawnLine;
      if (journal) {
        journalKey = deriveAgentKey(prefixHash, prompt, opts);
        prefixHash = journalKey;
        if (!hadMiss && replay) {
          const cached = replay.results.get(journalKey);
          if (cached !== void 0) {
            const respawns = replay.started.get(journalKey);
            if (respawns && respawns.length > 0) {
              debugLogger.info(
                `[Workflow] resume cache hit after ${respawns.length} prior respawn(s) for runId=${runId}.`
              );
            }
            const label2 = typeof opts.label === "string" ? opts.label : void 0;
            const dispatchId2 = issueDispatchTrace(
              prompt,
              opts,
              true,
              workflowCallId
            );
            try {
              emitter?.agentDispatched?.(label2);
            } catch (e) {
              debugLogger.warn("emitter.agentDispatched threw:", e);
            }
            try {
              emitter?.agentCompleted?.(label2);
            } catch (e) {
              debugLogger.warn("emitter.agentCompleted threw:", e);
            }
            try {
              emitter?.dispatchSettled?.(dispatchId2, void 0, Date.now());
            } catch (e) {
              debugLogger.warn("emitter.dispatchSettled threw:", e);
            }
            return scheduler.waitUntilRunning().then(
              () => cached.result,
              () => cached.result
            );
          }
        }
        const priorStarts = replay?.started.get(journalKey);
        if (priorStarts && priorStarts.length > 0 && !replay?.results.has(journalKey)) {
          const name = typeof opts.label === "string" ? `"${stripAnsiAndControl(opts.label)}"` : "an agent";
          respawnLine = replay?.failed.has(journalKey) ? `[resume] re-running ${name}: it failed in the previous run` : `[resume] respawning ${name}: interrupted in a previous run (${priorStarts.length} prior attempt${priorStarts.length === 1 ? "" : "s"})`;
        }
        hadMiss = true;
      }
      if (budget && budget.total !== null && budget.remaining() <= 0) {
        debugLogger.warn(
          `[Workflow] budget gate refused dispatch at entry: runId=${runId} spent=${budget.spent()} total=${budget.total}`
        );
        return rejectThroughPauseGate(
          new WorkflowBudgetExceededError(runId, budget.total, budget.spent())
        );
      }
      if (agentCount >= maxAgents) {
        return rejectThroughPauseGate(
          new WorkflowAgentCapExceededError(maxAgents)
        );
      }
      agentCount += 1;
      if (journal && journalKey !== void 0) {
        journalEntryId = String(journalAgentId += 1);
      }
      const label = typeof opts.label === "string" ? opts.label : void 0;
      const dispatchId = issueDispatchTrace(
        prompt,
        opts,
        false,
        workflowCallId
      );
      try {
        emitter?.agentDispatched?.(label);
      } catch (e) {
        debugLogger.warn("emitter.agentDispatched threw:", e);
      }
      let completionEmitted = false;
      const emitCompletion = /* @__PURE__ */ __name((error) => {
        if (completionEmitted) return;
        completionEmitted = true;
        const message = error === void 0 ? void 0 : error instanceof Error ? error.message : String(error);
        try {
          emitter?.agentCompleted?.(label, message);
        } catch (e) {
          debugLogger.warn("emitter.agentCompleted threw:", e);
        }
        try {
          emitter?.dispatchSettled?.(dispatchId, message, Date.now());
        } catch (e) {
          debugLogger.warn("emitter.dispatchSettled threw:", e);
        }
      }, "emitCompletion");
      return scheduler.run(async () => {
        try {
          try {
            emitter?.dispatchStarted?.(dispatchId, Date.now());
          } catch (e) {
            debugLogger.warn("emitter.dispatchStarted threw:", e);
          }
          if (budget && budget.total !== null && budget.remaining() <= 0) {
            debugLogger.warn(
              `[Workflow] budget gate refused dispatch at slot-acquire: runId=${runId} spent=${budget.spent()} total=${budget.total}`
            );
            throw new WorkflowBudgetExceededError(
              runId,
              budget.total,
              budget.spent()
            );
          }
          if (journal && journalKey !== void 0 && journalEntryId !== void 0) {
            journal.append({
              type: "started",
              key: journalKey,
              agentId: journalEntryId
            }).catch(
              (e) => debugLogger.warn(`journal started-append failed: ${e}`)
            );
          }
          if (respawnLine) {
            parentSandboxRef.current?.appendLog(respawnLine);
            try {
              emitter?.resumeRespawn?.(respawnLine);
            } catch (e) {
              debugLogger.warn("emitter.resumeRespawn threw:", e);
            }
          }
          const result = await this.dispatch(prompt, opts, dispatchId);
          emitCompletion();
          if (journal && journalKey !== void 0) {
            journal.append({
              type: "result",
              key: journalKey,
              agentId: journalEntryId ?? "",
              result
            }).catch(
              (e) => debugLogger.warn(`journal result-append failed: ${e}`)
            );
          }
          if (budget) {
            try {
              emitter?.budgetUpdated?.(...runBudgetFigures(budget));
            } catch (e) {
              debugLogger.warn("emitter.budgetUpdated threw:", e);
            }
          }
          return result;
        } catch (err) {
          emitCompletion(err);
          if (budget) {
            try {
              emitter?.budgetUpdated?.(...runBudgetFigures(budget));
            } catch (e) {
              debugLogger.warn("emitter.budgetUpdated threw:", e);
            }
          }
          if (journal && journalKey !== void 0 && !signal?.aborted && !isWorkflowRunLevelError(err)) {
            journal.append({
              type: "failed",
              key: journalKey,
              agentId: journalEntryId ?? ""
            }).catch(
              (e) => debugLogger.warn(`journal failed-append failed: ${e}`)
            );
          }
          if (signal?.aborted || isWorkflowRunLevelError(err)) throw err;
          if (isWorkflowAgentFailedError(err)) {
            debugLogger.warn(
              `[Workflow] agent settled to null (${err.kind}): ${err.message}`
            );
          } else {
            debugLogger.warn(
              `[Workflow] agent settled to null: ${extractErrorMessage(err)}`
            );
          }
          return null;
        }
      }).then(
        // Resolve even if the gate aborts: a successful dispatch must not
        // turn into a teardown rejection — for a fire-and-forget call the
        // script never attached a handler, so the rejection would surface
        // as a spurious process-level unhandledRejection alarm on a
        // correctly-cancelled run.
        (result) => scheduler.waitUntilRunning().then(
          () => result,
          () => result
        ),
        (error) => {
          emitCompletion(error);
          return scheduler.waitUntilRunning().then(
            () => {
              throw error;
            },
            () => {
              throw error;
            }
          );
        }
      );
    }, "countedDispatch");
    const parallelImpl = makeParallelImpl(signal, dependencyContext);
    const pipelineImpl = makePipelineImpl(signal, dependencyContext);
    let workflowCallCount = 0;
    const recordCall = /* @__PURE__ */ __name((call) => {
      try {
        emitter?.workflowCallUpdated?.({ ...call });
      } catch (error) {
        debugLogger.warn("emitter.workflowCallUpdated threw:", error);
      }
    }, "recordCall");
    const resolveSavedWorkflow = req.resolveSavedWorkflow;
    const workflowImpl = resolveSavedWorkflow ? async (nameOrRef, nestedArgs, stepId) => {
      const call = {
        id: `workflow-call-${++workflowCallCount}`,
        ...stepId !== void 0 ? { stepId: readWorkflowStepId(stepId) } : {},
        ...typeof nameOrRef === "string" ? { workflowName: nameOrRef } : {},
        status: "running",
        startedAt: Date.now()
      };
      const recorded = workflowCallCount <= MAX_WORKFLOW_CALL_TRACES;
      if (recorded) recordCall(call);
      else if (workflowCallCount === MAX_WORKFLOW_CALL_TRACES + 1) {
        try {
          emitter?.workflowCallsTruncated?.();
        } catch (error) {
          debugLogger.warn("emitter.workflowCallsTruncated threw:", error);
        }
      }
      let nestedSandbox;
      try {
        const resolved = await resolveSavedWorkflow(nameOrRef);
        if (resolved.name) call.workflowName = resolved.name;
        nestedSandbox = createWorkflowSandbox({
          args: nestedArgs,
          runId,
          // Each sandbox closes over its own call, including parallel and cached dispatches.
          dispatch: /* @__PURE__ */ __name((prompt, opts) => countedDispatch(prompt, opts, call.id), "dispatch"),
          parallel: parallelImpl,
          pipeline: pipelineImpl,
          abortOnTimeout: req.abortOnTimeout,
          emitter,
          budget,
          scheduler
          // No workflow implementation: preserve single-level nesting.
        });
        const result = await nestedSandbox.run(resolved.script);
        call.status = signal?.aborted ? "cancelled" : "completed";
        return result;
      } catch (error) {
        call.status = signal?.aborted ? "cancelled" : "failed";
        try {
          const message = typeof error === "string" ? error : error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message")?.value : void 0;
          if (typeof message === "string") call.error = message;
        } catch {
        }
        throw error;
      } finally {
        call.endedAt = Date.now();
        if (recorded) recordCall(call);
        for (const line of nestedSandbox?.getLogs() ?? []) {
          parentSandboxRef.current?.appendLog(line);
        }
      }
    } : void 0;
    const sandbox = createWorkflowSandbox({
      args: req.args,
      maxWallClockMs: req.maxWallClockMs,
      runId,
      dispatch: countedDispatch,
      parallel: parallelImpl,
      pipeline: pipelineImpl,
      workflow: workflowImpl,
      abortOnTimeout: req.abortOnTimeout,
      emitter,
      budget,
      scheduler
    });
    parentSandboxRef.current = sandbox;
    try {
      const result = await dependencyContext.run(
        { tails: [] },
        () => sandbox.run(req.script)
      );
      return {
        runId,
        result,
        phases: sandbox.getPhases(),
        logs: sandbox.getLogs(),
        meta: sandbox.getMeta()
      };
    } catch (err) {
      throw new WorkflowExecutionError(
        extractErrorMessage(err),
        sandbox.getPhases(),
        sandbox.getLogs(),
        sandbox.getMeta()
      );
    }
  }
};
async function settleToNullArray(thunks, signal) {
  const settled = await Promise.allSettled(
    thunks.map((t) => Promise.resolve().then(t))
  );
  if (signal?.aborted)
    throw new DOMException("Workflow run aborted.", "AbortError");
  const visitedReasons = /* @__PURE__ */ new WeakSet();
  const findRunFailureReason = /* @__PURE__ */ __name((reason) => {
    if (reason === null || typeof reason !== "object") return void 0;
    if (visitedReasons.has(reason)) return void 0;
    visitedReasons.add(reason);
    try {
      if (reason.__wfRunFailure === true) {
        return reason;
      }
      const errors = reason?.errors;
      if (!Array.isArray(errors)) return void 0;
      for (const error of errors) {
        const runFailure = findRunFailureReason(error);
        if (runFailure !== void 0) return runFailure;
      }
    } catch {
      return void 0;
    }
    return void 0;
  }, "findRunFailureReason");
  for (const result of settled) {
    if (result.status !== "rejected") continue;
    const runFailure = findRunFailureReason(result.reason);
    if (runFailure !== void 0) throw runFailure;
  }
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const reason = r.reason;
    debugLogger.warn(
      `Workflow thunk at index ${i} rejected: ${String(reason?.message ?? r.reason)}`
    );
    return null;
  });
}
__name(settleToNullArray, "settleToNullArray");
function makeParallelImpl(signal, dependencyContext) {
  return (thunks) => {
    if (!Array.isArray(thunks)) {
      return Promise.reject(
        new Error(
          "parallel() expects an array of thunks (functions returning promises)."
        )
      );
    }
    for (const t of thunks) {
      if (typeof t !== "function") {
        return Promise.reject(
          new Error(
            "parallel() expects an array of functions, not values \u2014 wrap each call: parallel([() => agent(...), () => agent(...)])."
          )
        );
      }
    }
    const parent = dependencyContext.getStore();
    const inheritedTails = parent?.tails ?? [];
    const branches = thunks.map((thunk) => {
      const store = { tails: [...inheritedTails] };
      return {
        store,
        thunk: /* @__PURE__ */ __name(() => dependencyContext.run(store, thunk), "thunk")
      };
    });
    return settleToNullArray(
      branches.map(({ thunk }) => thunk),
      signal
    ).then((result) => {
      if (parent && branches.length > 0) {
        parent.tails = mergeFanoutTails(
          parent.tails,
          inheritedTails,
          branches.flatMap(({ store }) => store.tails)
        );
      }
      return result;
    });
  };
}
__name(makeParallelImpl, "makeParallelImpl");
function makePipelineImpl(signal, dependencyContext) {
  return (items, ...stages) => {
    if (!Array.isArray(items)) {
      return Promise.reject(
        new Error(
          "pipeline() expects an array of items as its first argument."
        )
      );
    }
    for (const s of stages) {
      if (typeof s !== "function") {
        return Promise.reject(
          new Error(
            "pipeline() stages must be functions: pipeline(items, item => ..., result => ...)."
          )
        );
      }
    }
    const parent = dependencyContext.getStore();
    const inheritedTails = parent?.tails ?? [];
    const branches = items.map((item, idx) => {
      const store = { tails: [...inheritedTails] };
      return {
        store,
        thunk: /* @__PURE__ */ __name(() => dependencyContext.run(
          store,
          () => runPipelineChain(item, idx, stages)
        ), "thunk")
      };
    });
    return settleToNullArray(
      branches.map(({ thunk }) => thunk),
      signal
    ).then((result) => {
      if (parent && branches.length > 0) {
        parent.tails = mergeFanoutTails(
          parent.tails,
          inheritedTails,
          branches.flatMap(({ store }) => store.tails)
        );
      }
      return result;
    });
  };
}
__name(makePipelineImpl, "makePipelineImpl");
function mergeFanoutTails(currentParentTails, inheritedTails, branchTails) {
  const inherited = new Set(inheritedTails);
  const newBranchTails = branchTails.filter((tail) => !inherited.has(tail));
  const merged = newBranchTails.length > 0 ? [
    ...newBranchTails,
    ...currentParentTails.filter((tail) => !inherited.has(tail))
  ] : currentParentTails;
  return Array.from(new Set(merged));
}
__name(mergeFanoutTails, "mergeFanoutTails");
async function runPipelineChain(item, idx, stages) {
  let prev = item;
  for (const stage of stages) {
    if (prev === null) break;
    prev = await stage(prev, item, idx);
  }
  return prev;
}
__name(runPipelineChain, "runPipelineChain");
function extractErrorMessage(err) {
  if (err && typeof err === "object" && "message" in err) {
    const m = err.message;
    if (typeof m === "string") return m;
    return String(m);
  }
  return String(err);
}
__name(extractErrorMessage, "extractErrorMessage");

// packages/core/src/agents/workflow-snapshot.ts
init_esbuild_shims();
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
var debugLogger5 = createDebugLogger("WORKFLOW_SNAPSHOT");
var MAX_RETAINED_SNAPSHOTS = 30;
function toSnapshot(task) {
  if (!isTerminalWorkflowStatus(task.status)) {
    throw new Error(`Cannot snapshot active workflow ${task.runId}.`);
  }
  return {
    runId: task.runId,
    ...task.sourceRef ? { sourceRef: { ...task.sourceRef } } : {},
    ...task.workflowCalls ? { workflowCalls: task.workflowCalls.map((call) => ({ ...call })) } : {},
    ...task.workflowCallsTruncated ? { workflowCallsTruncated: true } : {},
    ...task.toolUseId ? { toolUseId: task.toolUseId } : {},
    description: task.description,
    ...task.workflowName ? { workflowName: task.workflowName } : {},
    sourceRunId: task.sourceRunId,
    startMode: task.startMode,
    meta: task.meta,
    status: task.status,
    script: task.script ?? "",
    scriptPath: task.scriptPath,
    phases: [...task.phases],
    phaseVisits: task.phaseVisits.map((visit) => ({ ...visit })),
    dispatches: task.dispatches.map((dispatch) => ({
      ...dispatch,
      dependsOn: [...dispatch.dependsOn]
    })),
    agentsDispatched: task.agentsDispatched,
    agentsCompleted: task.agentsCompleted,
    agentsRespawned: task.agentsRespawned ?? 0,
    ...task.sizeWarning ? { sizeWarning: { ...task.sizeWarning } } : {},
    tokensSpent: task.tokensSpent,
    tokenBudgetTotal: task.tokenBudgetTotal,
    perPhaseTokens: Array.from(task.perPhaseTokens.entries()),
    recentLogs: [...task.recentLogs],
    events: task.events.map((event) => ({ ...event })),
    startTime: task.startTime,
    endTime: task.endTime,
    result: safeResult(task.result),
    error: task.error
  };
}
__name(toSnapshot, "toSnapshot");
function safeResult(result) {
  if (result === void 0) return void 0;
  try {
    JSON.stringify(result);
    return result;
  } catch {
    return `(non-JSON-serializable ${typeof result})`;
  }
}
__name(safeResult, "safeResult");
async function writeWorkflowSnapshot(config, task) {
  const storage = config.storage;
  if (!storage) return false;
  try {
    const snapshot = toSnapshot(task);
    const dir = storage.getWorkflowRunsDir();
    await fs2.mkdir(dir, { recursive: true });
    await fs2.writeFile(
      storage.getWorkflowRunSnapshotPath(task.runId),
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
    await pruneSnapshots(config, dir);
    return true;
  } catch (e) {
    debugLogger5.warn(`writeWorkflowSnapshot failed for ${task.runId}: ${e}`);
    return false;
  }
}
__name(writeWorkflowSnapshot, "writeWorkflowSnapshot");
async function listWorkflowSnapshots(config) {
  const storage = config.storage;
  if (!storage) return [];
  const dir = storage.getWorkflowRunsDir();
  let files;
  try {
    files = (await fs2.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const snapshots = [];
  for (const file of files) {
    try {
      const raw = await fs2.readFile(`${dir}/${file}`, "utf8");
      const parsed = JSON.parse(raw);
      if (!isWorkflowSnapshot(parsed)) {
        debugLogger5.warn(`skipping invalid workflow snapshot ${file}`);
        continue;
      }
      snapshots.push(parsed);
    } catch (e) {
      debugLogger5.warn(`skipping unparseable snapshot ${file}: ${e}`);
    }
  }
  snapshots.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  return snapshots;
}
__name(listWorkflowSnapshots, "listWorkflowSnapshots");
async function deleteWorkflowSnapshot(config, runId) {
  const storage = config.storage;
  if (!storage || !/^wf_[0-9a-f]+$/.test(runId)) return false;
  try {
    await fs2.rm(path2.dirname(storage.getWorkflowRunJournalPath(runId)), {
      recursive: true,
      force: true
    });
  } catch (error) {
    debugLogger5.warn(`delete workflow journal failed for ${runId}: ${error}`);
    return false;
  }
  if (!await deleteInlineWorkflowScript(config, runId)) return false;
  try {
    await fs2.unlink(storage.getWorkflowRunSnapshotPath(runId));
  } catch (error) {
    if (error.code !== "ENOENT") {
      debugLogger5.warn(`deleteWorkflowSnapshot failed for ${runId}: ${error}`);
      return false;
    }
  }
  return true;
}
__name(deleteWorkflowSnapshot, "deleteWorkflowSnapshot");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
__name(isFiniteNumber, "isFiniteNumber");
function isOptionalString(value) {
  return value === void 0 || typeof value === "string";
}
__name(isOptionalString, "isOptionalString");
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
__name(isStringArray, "isStringArray");
function isWorkflowMeta(value) {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value["name"] !== "string" || typeof value["description"] !== "string" || !isOptionalString(value["whenToUse"])) {
    return false;
  }
  const phases = value["phases"];
  return phases === void 0 || Array.isArray(phases) && phases.every(
    (phase) => isRecord(phase) && typeof phase["title"] === "string" && isOptionalString(phase["detail"]) && isOptionalString(phase["model"])
  );
}
__name(isWorkflowMeta, "isWorkflowMeta");
function isWorkflowPhaseVisit(value) {
  return isRecord(value) && typeof value["id"] === "string" && isFiniteNumber(value["index"]) && typeof value["title"] === "string" && isFiniteNumber(value["startedAt"]) && (value["endedAt"] === void 0 || isFiniteNumber(value["endedAt"]));
}
__name(isWorkflowPhaseVisit, "isWorkflowPhaseVisit");
function isWorkflowDispatch(value) {
  if (!isRecord(value)) return false;
  const status = value["status"];
  return typeof value["id"] === "string" && (value["phaseVisitId"] === null || typeof value["phaseVisitId"] === "string") && typeof value["label"] === "string" && typeof value["prompt"] === "string" && isOptionalString(value["subagentId"]) && isOptionalString(value["stepId"]) && isOptionalString(value["workflowCallId"]) && (status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "cancelled" || status === "cached") && isStringArray(value["dependsOn"]) && isFiniteNumber(value["queuedAt"]) && (value["startedAt"] === void 0 || isFiniteNumber(value["startedAt"])) && (value["endedAt"] === void 0 || isFiniteNumber(value["endedAt"])) && isOptionalString(value["error"]);
}
__name(isWorkflowDispatch, "isWorkflowDispatch");
function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
__name(hasOnlyKeys, "hasOnlyKeys");
function isWorkflowEvent(value) {
  if (!isRecord(value) || typeof value["id"] !== "string" || !isFiniteNumber(value["at"]) || typeof value["type"] !== "string") {
    return false;
  }
  const base = ["id", "type", "at"];
  switch (value["type"]) {
    case "phase-started":
      return hasOnlyKeys(value, [...base, "phaseVisitId", "title"]) && typeof value["phaseVisitId"] === "string" && typeof value["title"] === "string";
    case "phase-completed":
      return hasOnlyKeys(value, [...base, "phaseVisitId"]) && typeof value["phaseVisitId"] === "string";
    case "dispatch-queued":
    case "dispatch-started":
    case "dispatch-completed":
    case "dispatch-cancelled":
    case "dispatch-cached":
      return hasOnlyKeys(value, [...base, "dispatchId"]) && typeof value["dispatchId"] === "string";
    case "dispatch-failed":
      return hasOnlyKeys(value, [...base, "dispatchId", "error"]) && typeof value["dispatchId"] === "string" && typeof value["error"] === "string";
    case "log":
      return hasOnlyKeys(value, [...base, "message"]) && typeof value["message"] === "string";
    case "approval-requested":
    case "approval-settled":
      return hasOnlyKeys(value, [...base, "name", "dispatchId"]) && typeof value["name"] === "string" && isOptionalString(value["dispatchId"]);
    case "workflow-completed":
    case "workflow-cancelled":
      return hasOnlyKeys(value, base);
    case "workflow-failed":
      return hasOnlyKeys(value, [...base, "error"]) && typeof value["error"] === "string";
    default:
      return false;
  }
}
__name(isWorkflowEvent, "isWorkflowEvent");
function isWorkflowCall(value) {
  if (!isRecord(value)) return false;
  const status = value["status"];
  return typeof value["id"] === "string" && isOptionalString(value["stepId"]) && isOptionalString(value["workflowName"]) && (status === "running" || status === "completed" || status === "failed" || status === "cancelled") && isFiniteNumber(value["startedAt"]) && (value["endedAt"] === void 0 || isFiniteNumber(value["endedAt"])) && isOptionalString(value["error"]);
}
__name(isWorkflowCall, "isWorkflowCall");
function isWorkflowSnapshot(value) {
  if (!isRecord(value)) return false;
  const status = value["status"];
  const workflowCalls = value["workflowCalls"];
  const phaseVisits = value["phaseVisits"];
  const dispatches = value["dispatches"];
  const events = value["events"];
  const perPhaseTokens = value["perPhaseTokens"];
  return (value["sourceRef"] === void 0 || isWorkflowSourceRef(value["sourceRef"])) && (workflowCalls === void 0 || Array.isArray(workflowCalls) && workflowCalls.length <= MAX_WORKFLOW_CALL_TRACES && workflowCalls.every(isWorkflowCall)) && (value["workflowCallsTruncated"] === void 0 || typeof value["workflowCallsTruncated"] === "boolean") && typeof value["runId"] === "string" && value["runId"].length > 0 && isOptionalString(value["toolUseId"]) && isOptionalString(value["description"]) && isOptionalString(value["workflowName"]) && isOptionalString(value["sourceRunId"]) && (value["startMode"] === void 0 || value["startMode"] === "retry" || value["startMode"] === "rerun") && isWorkflowMeta(value["meta"]) && (status === "completed" || status === "failed" || status === "cancelled") && typeof value["script"] === "string" && isOptionalString(value["scriptPath"]) && isStringArray(value["phases"]) && (phaseVisits === void 0 || Array.isArray(phaseVisits) && phaseVisits.every(isWorkflowPhaseVisit)) && (dispatches === void 0 || Array.isArray(dispatches) && dispatches.every(isWorkflowDispatch)) && (events === void 0 || Array.isArray(events) && events.every(isWorkflowEvent)) && isFiniteNumber(value["agentsDispatched"]) && isFiniteNumber(value["agentsCompleted"]) && (value["agentsRespawned"] === void 0 || isFiniteNumber(value["agentsRespawned"])) && (value["sizeWarning"] === void 0 || isWorkflowSizeWarning(value["sizeWarning"])) && isFiniteNumber(value["tokensSpent"]) && (value["tokenBudgetTotal"] === null || isFiniteNumber(value["tokenBudgetTotal"])) && Array.isArray(perPhaseTokens) && perPhaseTokens.every(
    (entry) => Array.isArray(entry) && entry.length === 2 && (entry[0] === null || typeof entry[0] === "string") && isFiniteNumber(entry[1])
  ) && isStringArray(value["recentLogs"]) && isFiniteNumber(value["startTime"]) && (value["endTime"] === void 0 || isFiniteNumber(value["endTime"])) && isOptionalString(value["error"]);
}
__name(isWorkflowSnapshot, "isWorkflowSnapshot");
async function pruneSnapshots(config, dir) {
  let files;
  try {
    files = (await fs2.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  if (files.length <= MAX_RETAINED_SNAPSHOTS) return;
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await fs2.stat(`${dir}/${f}`);
        return { f, mtime: s.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  const toPrune = stats.slice(0, stats.length - MAX_RETAINED_SNAPSHOTS);
  const registry = config.getWorkflowRunRegistry?.();
  const protectedRunIds = /* @__PURE__ */ new Set([
    ...(registry?.list() ?? []).filter((entry) => isActiveWorkflowStatus(entry.status)).map((entry) => entry.runId),
    ...registry?.listStartingRunIds() ?? []
  ]);
  await Promise.all(
    toPrune.map((s) => {
      const runId = s.f.replace(/\.json$/, "");
      const isRunDir = /^wf_[0-9a-f]+$/.test(runId);
      const deleteArtifacts = isRunDir && !protectedRunIds.has(runId) && !isWorkflowRunPersistenceActive(config, runId);
      return Promise.all([
        fs2.unlink(`${dir}/${s.f}`).catch(
          (e) => debugLogger5.warn(`prune unlink failed for ${s.f}: ${e}`)
        ),
        ...deleteArtifacts ? [
          fs2.rm(
            path2.dirname(config.storage.getWorkflowRunJournalPath(runId)),
            { recursive: true, force: true }
          ).catch(
            (e) => debugLogger5.warn(
              `prune journal dir failed for ${runId}: ${e}`
            )
          ),
          deleteInlineWorkflowScript(config, runId)
        ] : []
      ]);
    })
  );
}
__name(pruneSnapshots, "pruneSnapshots");

// packages/core/src/agents/runtime/workflow-script-shape.ts
init_esbuild_shims();
var PROMPT_SUMMARY_CHARS = 60;
var LOOP_HEAD_CHARS = 40;
var MAX_PROMPTS_PER_ROW = 2;
var MAX_VIOLATIONS_LISTED = 5;
var PROMPT_READ_LIMIT = 400;
var IDENT_START = /[A-Za-z_$]/;
var IDENT_PART = /[A-Za-z0-9_$]/;
var SPACE = /\s/;
function maskNonCode(source) {
  const n = source.length;
  const out = source.split("");
  const blank = /* @__PURE__ */ __name((from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  }, "blank");
  const templateStack = [];
  let braceDepth = 0;
  const scanTemplateText = /* @__PURE__ */ __name((from) => {
    let j = from;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "`") {
        blank(from, j + 1);
        return j + 1;
      }
      if (ch === "$" && source[j + 1] === "{") {
        blank(from, j + 2);
        templateStack.push(braceDepth);
        braceDepth++;
        return j + 2;
      }
      j++;
    }
    blank(from, n);
    return n;
  }, "scanTemplateText");
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const newline = source.indexOf("\n", i);
      const end = newline === -1 ? n : newline;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const end = Math.min(n, j + 1);
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "`") {
      blank(i, i + 1);
      i = scanTemplateText(i + 1);
      continue;
    }
    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth - 1) {
        templateStack.pop();
        braceDepth--;
        blank(i, i + 1);
        i = scanTemplateText(i + 1);
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
    i++;
  }
  return out.join("");
}
__name(maskNonCode, "maskNonCode");
function collapse(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
__name(collapse, "collapse");
function readPromptSummary(source, from) {
  let p = from;
  while (p < source.length && SPACE.test(source[p])) p++;
  const quote = source[p];
  if (quote !== '"' && quote !== "'" && quote !== "`") return void 0;
  let text = "";
  let j = p + 1;
  while (j < source.length && text.length < PROMPT_READ_LIMIT) {
    const ch = source[j];
    if (ch === "\\") {
      const escaped = source[j + 1] ?? "";
      text += escaped === "n" || escaped === "t" || escaped === "r" ? " " : escaped;
      j += 2;
      continue;
    }
    if (ch === quote) break;
    if (quote !== "`" && ch === "\n") break;
    if (quote === "`" && ch === "$" && source[j + 1] === "{") {
      let depth = 1;
      j += 2;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") depth--;
        j++;
      }
      text += "\u2026";
      continue;
    }
    text += ch;
    j++;
  }
  const summary = collapse(text, PROMPT_SUMMARY_CHARS);
  return summary.length > 0 ? summary : void 0;
}
__name(readPromptSummary, "readPromptSummary");
function scanWorkflowScriptShape(source) {
  const code = maskNonCode(source);
  const n = code.length;
  const rows = [];
  const rowByContext = /* @__PURE__ */ new Map();
  const violations = [];
  const stack = [];
  const doBodyCloses = /* @__PURE__ */ new Set();
  let lastRow;
  let lastRowWasTopLevel = false;
  let agentCalls = 0;
  let depth = 0;
  let line = 1;
  let nextId = 0;
  const skipSpace = /* @__PURE__ */ __name((from) => {
    let k = from;
    while (k < n && SPACE.test(code[k])) k++;
    return k;
  }, "skipSpace");
  const readIdent = /* @__PURE__ */ __name((from) => {
    let k = from;
    while (k < n && IDENT_PART.test(code[k])) k++;
    return code.slice(from, k);
  }, "readIdent");
  const previousNonSpaceIndex = /* @__PURE__ */ __name((from) => {
    let k = from - 1;
    while (k >= 0 && SPACE.test(code[k])) k--;
    return k;
  }, "previousNonSpaceIndex");
  const followsNew = /* @__PURE__ */ __name((start) => {
    const k = previousNonSpaceIndex(start);
    return k >= 2 && code.slice(k - 2, k + 1) === "new" && !IDENT_PART.test(code[k - 3] ?? "");
  }, "followsNew");
  const matchingClose = /* @__PURE__ */ __name((open) => {
    let d = 0;
    for (let k = open; k < n; k++) {
      const c = code[k];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") {
        d--;
        if (d === 0) return k;
      }
    }
    return -1;
  }, "matchingClose");
  const innermost = /* @__PURE__ */ __name((at) => {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (at >= stack[s].bodyStart) return stack[s];
    }
    return void 0;
  }, "innermost");
  const popClosedBlocks = /* @__PURE__ */ __name((closeIndex) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const closes = top.statement ? depth < top.openDepth : closeIndex > top.bodyStart && depth <= top.openDepth;
      if (!closes) break;
      stack.pop();
      if (top.isDo) doBodyCloses.add(closeIndex);
      if (top.kind === "parallel") recordEmptyFanOut(top);
    }
  }, "popClosedBlocks");
  const recordEmptyFanOut = /* @__PURE__ */ __name((closed) => {
    if (rows.length !== closed.rowsAtOpen) return;
    if (stack.some((context) => context.kind === "parallel")) return;
    const row = {
      kind: "parallel",
      count: 0,
      prompts: [],
      line: closed.line
    };
    rows.push(row);
    lastRow = row;
    lastRowWasTopLevel = false;
  }, "recordEmptyFanOut");
  const popEndedStatements = /* @__PURE__ */ __name(() => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top.statement || !top.consumed || depth !== top.openDepth) break;
      stack.pop();
    }
  }, "popEndedStatements");
  const recordAgent = /* @__PURE__ */ __name((start, open) => {
    agentCalls++;
    const context = innermost(start);
    const prompt = readPromptSummary(source, open + 1);
    let row;
    if (context) {
      row = rowByContext.get(context.id);
      if (!row) {
        row = {
          kind: context.kind,
          count: 0,
          ...context.condition ? { condition: context.condition } : {},
          prompts: [],
          line
        };
        rowByContext.set(context.id, row);
        rows.push(row);
      }
    } else if (lastRow?.kind === "step" && lastRowWasTopLevel) {
      row = lastRow;
    } else {
      row = { kind: "step", count: 0, prompts: [], line };
      rows.push(row);
    }
    row.count++;
    if (prompt !== void 0 && row.prompts.length < MAX_PROMPTS_PER_ROW) {
      row.prompts.push(prompt);
    }
    lastRow = row;
    lastRowWasTopLevel = context === void 0;
  }, "recordAgent");
  const recordMemberCall = /* @__PURE__ */ __name((object, end, names) => {
    const dot = skipSpace(end);
    if (code[dot] !== ".") return;
    const nameStart = skipSpace(dot + 1);
    const name = readIdent(nameStart);
    if (!names.includes(name)) return;
    if (code[skipSpace(nameStart + name.length)] !== "(") return;
    violations.push({
      call: `${object}.${name}()`,
      line
    });
  }, "recordMemberCall");
  const handleWord = /* @__PURE__ */ __name((word, start, end) => {
    switch (word) {
      case "agent": {
        const open = skipSpace(end);
        if (code[open] === "(") recordAgent(start, open);
        return;
      }
      case "parallel":
      case "pipeline": {
        const open = skipSpace(end);
        if (code[open] !== "(") return;
        stack.push({
          kind: "parallel",
          id: nextId++,
          line,
          rowsAtOpen: rows.length,
          openDepth: depth,
          bodyStart: open,
          statement: false,
          consumed: false,
          isDo: false
        });
        return;
      }
      case "while":
      case "for": {
        if (word === "while" && doBodyCloses.has(previousNonSpaceIndex(start))) {
          return;
        }
        let open = skipSpace(end);
        if (word === "for" && code.startsWith("await", open) && !IDENT_PART.test(code[open + 5] ?? "")) {
          open = skipSpace(open + 5);
        }
        if (code[open] !== "(") return;
        const close = matchingClose(open);
        if (close === -1) return;
        const body = skipSpace(close + 1);
        if (body >= n || code[body] === ";") return;
        stack.push({
          kind: "loop",
          id: nextId++,
          line,
          rowsAtOpen: rows.length,
          openDepth: depth,
          bodyStart: body,
          statement: code[body] !== "{",
          condition: `${word} (${collapse(source.slice(open + 1, close), LOOP_HEAD_CHARS)})`,
          consumed: false,
          isDo: false
        });
        return;
      }
      case "do": {
        const body = skipSpace(end);
        if (code[body] !== "{") return;
        stack.push({
          kind: "loop",
          id: nextId++,
          line,
          rowsAtOpen: rows.length,
          openDepth: depth,
          bodyStart: body,
          statement: false,
          condition: "do \u2026 while",
          consumed: false,
          isDo: true
        });
        return;
      }
      case "Math":
        recordMemberCall("Math", end, ["random"]);
        return;
      case "Date": {
        if (code[skipSpace(end)] === "(") {
          if (!followsNew(start)) violations.push({ call: "Date()", line });
          return;
        }
        recordMemberCall("Date", end, ["now", "parse", "UTC"]);
        return;
      }
      case "new": {
        const target = skipSpace(end);
        if (readIdent(target) === "Date" && code[skipSpace(target + 4)] !== ".") {
          violations.push({ call: "new Date()", line });
        }
        return;
      }
      default:
        return;
    }
  }, "handleWord");
  for (let i = 0; i < n; i++) {
    const ch = code[i];
    if (ch === "\n") {
      line++;
      popEndedStatements();
      continue;
    }
    if (SPACE.test(ch)) continue;
    const top = stack[stack.length - 1];
    if (top?.statement && i >= top.bodyStart) top.consumed = true;
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      popClosedBlocks(i);
      continue;
    }
    if (ch === ";") {
      popEndedStatements();
      continue;
    }
    if (!IDENT_START.test(ch) || i > 0 && IDENT_PART.test(code[i - 1])) {
      continue;
    }
    const word = readIdent(i);
    const end = i + word.length;
    const prev = previousNonSpaceIndex(i);
    if (prev < 0 || code[prev] !== ".") handleWord(word, i, end);
    i = end - 1;
  }
  return { rows, agentCalls, determinismViolations: violations };
}
__name(scanWorkflowScriptShape, "scanWorkflowScriptShape");
function describeWorkflowDeterminismViolations(violations) {
  const listed = violations.slice(0, MAX_VIOLATIONS_LISTED).map((v) => `${v.call} on line ${v.line}`);
  const more = violations.length - listed.length;
  const where = more > 0 ? `${listed.join(", ")} and ${more} more` : listed.join(", ");
  return `Workflow scripts must be deterministic so a resume replays the same calls, and this script calls ${where}. None of these is available in a workflow script: pass timestamps or seeds in through \`args\`, or stamp the result after the workflow returns.`;
}
__name(describeWorkflowDeterminismViolations, "describeWorkflowDeterminismViolations");

// packages/core/src/skills/workflow-authoring-skill.ts
init_esbuild_shims();
import { readFileSync } from "node:fs";
import * as path3 from "node:path";
var debugLogger6 = createDebugLogger("WORKFLOW_AUTHORING_SKILL");
var WORKFLOW_AUTHORING_SKILL_NAME = "workflow-authoring";
var cachedReference;
function referencePath() {
  return path3.join(
    resolveBundleDir(import.meta.url),
    "bundled",
    WORKFLOW_AUTHORING_SKILL_NAME,
    "SKILL.md"
  );
}
__name(referencePath, "referencePath");
function readWorkflowAuthoringReference() {
  if (cachedReference !== void 0) return cachedReference;
  try {
    const filePath = referencePath();
    const parsed = parseSkillContent(readFileSync(filePath, "utf8"), filePath);
    cachedReference = { body: parsed.body, baseDir: path3.dirname(filePath) };
  } catch (error) {
    debugLogger6.warn(`cannot read the workflow-authoring reference: ${error}`);
    cachedReference = null;
  }
  return cachedReference;
}
__name(readWorkflowAuthoringReference, "readWorkflowAuthoringReference");
function resolveWorkflowAuthoringRoute(config) {
  try {
    if (config.getDisabledSkillLevels?.()?.has("bundled")) return "withheld";
    if (config.isSkillEnabled?.({
      name: WORKFLOW_AUTHORING_SKILL_NAME,
      level: "bundled"
    }) === false) {
      return "withheld";
    }
    if (!config.getSkillManager?.()) return "inline";
    const registry = config.getToolRegistry?.();
    const toolNames = registry?.getAllToolNames?.();
    if (!Array.isArray(toolNames)) return "skill";
    if (!toolNames.includes(ToolNames.SKILL)) return "inline";
    if (isToolDeferredBehindToolSearch(config, ToolNames.SKILL)) {
      return toolNames.includes(ToolNames.TOOL_SEARCH) ? "skill-via-tool-search" : "inline";
    }
    return "skill";
  } catch (error) {
    debugLogger6.warn(`cannot resolve the workflow-authoring route: ${error}`);
    return "skill";
  }
}
__name(resolveWorkflowAuthoringRoute, "resolveWorkflowAuthoringRoute");
function resolveWorkflowAuthoringSurface(config) {
  const route = resolveWorkflowAuthoringRoute(config);
  switch (route) {
    case "skill":
      return "pointer";
    case "skill-via-tool-search":
      return "pointer-via-tool-search";
    case "withheld":
      return "withheld";
    case "inline":
      return readWorkflowAuthoringReference() ? "inline" : "pointer";
    default: {
      const unhandled = route;
      return unhandled;
    }
  }
}
__name(resolveWorkflowAuthoringSurface, "resolveWorkflowAuthoringSurface");
function isToolDeferredBehindToolSearch(config, name) {
  if (!config.getToolRegistry?.()?.isPermissionDeferred?.(name)) return false;
  return !config.getVisibleTools?.()?.has(name);
}
__name(isToolDeferredBehindToolSearch, "isToolDeferredBehindToolSearch");
function isToolHiddenBehindToolSearch(config, name) {
  if (!isToolDeferredBehindToolSearch(config, name)) return false;
  return !config.getToolRegistry?.()?.isDeferredToolRevealed?.(name);
}
__name(isToolHiddenBehindToolSearch, "isToolHiddenBehindToolSearch");
function toolSearchRevealSentence(toolDisplayName) {
  return `If the ${toolDisplayName} tool is not in your tool list, reveal it with ToolSearch first.`;
}
__name(toolSearchRevealSentence, "toolSearchRevealSentence");

// packages/core/src/agents/runtime/review-workflow.ts
init_esbuild_shims();
import { createHash as createHash2 } from "node:crypto";
import { promises as fs3 } from "node:fs";
import path4 from "node:path";
var debugLogger7 = createDebugLogger("REVIEW_WORKFLOW");
function resolveReviewWorkflowConcurrency(env = process.env) {
  const configured = parsePositiveIntegerEnv(env[MAX_WORKFLOW_CONCURRENCY_ENV], 0) || parsePositiveIntegerEnv(env["QWEN_CODE_MAX_TOOL_CONCURRENCY"], 10);
  return resolveConcurrencyLimit({
    [MAX_WORKFLOW_CONCURRENCY_ENV]: String(configured)
  });
}
__name(resolveReviewWorkflowConcurrency, "resolveReviewWorkflowConcurrency");
async function resolveReviewWorkflowLimits(scriptPath, generatedDir, scriptContent, env = process.env, nowMs = Date.now()) {
  let canonicalScript;
  try {
    if ((await fs3.lstat(generatedDir)).isSymbolicLink()) return void 0;
    const generatedRoot = await fs3.realpath(generatedDir);
    canonicalScript = await fs3.realpath(scriptPath);
    if (!canonicalScript.startsWith(path4.join(generatedRoot, "review") + path4.sep)) {
      return void 0;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      debugLogger7.warn(
        "Cannot classify review workflow; using generic limits:",
        error
      );
    }
    return void 0;
  }
  const digest = /^qwen-review-[a-f0-9]{10}-([a-f0-9]{64})\.js$/.exec(
    path4.basename(canonicalScript)
  )?.[1];
  if (!digest || createHash2("sha256").update(scriptContent).digest("hex") !== digest) {
    return void 0;
  }
  const seconds = Number(env["QWEN_CODE_MAX_WORKFLOW_SECONDS"]);
  let maxWallClockMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 6 * 60 * 60) * 1e3;
  const deadline = Number(env["QWEN_REVIEW_DEADLINE_EPOCH"]);
  if (Number.isFinite(deadline) && deadline > 0) {
    const rawFloor = env["QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS"];
    const floor = Number(rawFloor);
    const floorSeconds = rawFloor?.trim() && Number.isFinite(floor) && floor >= 0 ? floor : 1200;
    const remainingMs = deadline * 1e3 - nowMs - floorSeconds * 1e3;
    if (remainingMs <= 0) {
      throw new Error(
        "Review workflow was not launched: the review deadline has reached the compose reserve floor. Recover completed findings and compose now."
      );
    }
    maxWallClockMs = Math.min(maxWallClockMs, remainingMs);
  }
  return {
    subagent: {
      max_turns: resolveSubagentMaxTurns(env, 500),
      max_time_minutes: resolveSubagentMaxTimeMinutes(env, 100)
    },
    concurrency: resolveReviewWorkflowConcurrency(env),
    maxWallClockMs
  };
}
__name(resolveReviewWorkflowLimits, "resolveReviewWorkflowLimits");

export {
  MAX_TOKENS_PER_WORKFLOW_ENV,
  WorkflowBudgetImpl,
  WorkflowJournal,
  WorkflowDispatchScheduler,
  DEFAULT_MAX_AGENTS_PER_RUN,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  resolveConcurrencyLimit,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WorkflowExecutionError,
  createProductionDispatch,
  WorkflowOrchestrator,
  MAX_RETAINED_SNAPSHOTS,
  toSnapshot,
  writeWorkflowSnapshot,
  listWorkflowSnapshots,
  deleteWorkflowSnapshot,
  scanWorkflowScriptShape,
  describeWorkflowDeterminismViolations,
  resolveReviewWorkflowConcurrency,
  resolveReviewWorkflowLimits,
  WORKFLOW_AUTHORING_SKILL_NAME,
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringSurface,
  isToolHiddenBehindToolSearch,
  toolSearchRevealSentence
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
