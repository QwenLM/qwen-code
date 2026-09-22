// Force strict mode and setup for ESM
"use strict";
import {
  ProcessRegistry
} from "./chunk-L7TJUPNR.js";
import {
  createStderrForwarder
} from "./chunk-YYNEF4AU.js";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream
} from "./chunk-IJOS26LH.js";
import {
  AgentEventEmitter,
  renderSubagentSystemPrompt
} from "./chunk-MRTRBONQ.js";
import {
  sanitizeChildEnv
} from "./chunk-65I7S4Z3.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/external-agents/acp-subagent-executor.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

// packages/core/src/subagent-runtime.ts
init_esbuild_shims();

// packages/cli/src/external-agents/acp-subagent-executor.ts
var INIT_TIMEOUT_MS = 1e4;
var debugLogger = createDebugLogger("EXTERNAL_AGENT");
function externalModelLabel(command) {
  return `external-acp:${command.split(/[\\/]/).pop() ?? command}`;
}
__name(externalModelLabel, "externalModelLabel");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
var EXTERNAL_ACTION_PROMPT_MAX = 300;
function stripControlChars(value) {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 32 && code !== 127 && !(code >= 128 && code <= 159) ? ch : " ";
  }
  return out;
}
__name(stripControlChars, "stripControlChars");
function describeExternalAction(toolCall) {
  const title = stripControlChars(
    toolCall.title ?? toolCall.kind ?? "External action"
  );
  const raw = toolCall.rawInput;
  if (!isRecord(raw)) return title;
  const detail = stripControlChars(JSON.stringify(raw));
  const rendered = `${title}: ${detail}`;
  return rendered.length > EXTERNAL_ACTION_PROMPT_MAX ? `${rendered.slice(0, EXTERNAL_ACTION_PROMPT_MAX)}\u2026` : rendered;
}
__name(describeExternalAction, "describeExternalAction");
function assertExternalAgentSpawnPlatformSupported(platform = process.platform) {
  if (platform === "win32") {
    throw new Error(
      "External agents are not supported on Windows in this release: the executor spawn is POSIX-only. An npm-installed adapter resolves to a `.cmd` launcher that cannot be spawned without a shell, and the process-tree reaping is POSIX-specific. Run the external agent on macOS/Linux (or WSL). Windows support is a tracked follow-up."
    );
  }
}
__name(assertExternalAgentSpawnPlatformSupported, "assertExternalAgentSpawnPlatformSupported");
function resolvePermissionMode(permissionMode, approvalMode) {
  switch ((approvalMode ?? permissionMode ?? "").trim().toLowerCase()) {
    case "auto":
    case "acceptedits":
    case "auto-edit":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypasspermissions":
    case "bypass":
    case "yolo":
      return "bypass";
    default:
      return "default";
  }
}
__name(resolvePermissionMode, "resolvePermissionMode");
var POLICY_MODE_ALIASES = {
  bypass: ["bypassPermissions", "yolo"],
  acceptEdits: ["acceptEdits", "auto-edit", "auto"],
  plan: ["plan"],
  default: ["default"]
};
function selectPeerModeId(policy, availableModeIds) {
  return POLICY_MODE_ALIASES[policy].find(
    (id) => availableModeIds.includes(id)
  );
}
__name(selectPeerModeId, "selectPeerModeId");
function optionKindForOutcome(outcome) {
  switch (outcome) {
    case "proceed_once" /* ProceedOnce */:
    case "proceed_once_and_switch_to_default" /* ProceedOnceAndSwitchToDefault */:
      return "allow_once";
    case "proceed_always" /* ProceedAlways */:
    case "proceed_always_server" /* ProceedAlwaysServer */:
    case "proceed_always_tool" /* ProceedAlwaysTool */:
    case "proceed_always_project" /* ProceedAlwaysProject */:
    case "proceed_always_user" /* ProceedAlwaysUser */:
      return "allow_always";
    case "modify_with_editor" /* ModifyWithEditor */:
    case "cancel" /* Cancel */:
    case "restore_previous" /* RestorePrevious */:
      return "reject_once";
    default: {
      const exhaustive = outcome;
      void exhaustive;
      return "reject_once";
    }
  }
}
__name(optionKindForOutcome, "optionKindForOutcome");
function selectPermissionOption(options, outcome) {
  if (outcome === "cancel" /* Cancel */) return void 0;
  if (new Set(options.map((option) => option.optionId)).size !== options.length) {
    return void 0;
  }
  const kind = optionKindForOutcome(outcome);
  return (options.find((option) => option.kind === kind) ?? (kind === "allow_always" ? options.find((option) => option.kind === "allow_once") : void 0) ?? options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind === "reject_always"))?.optionId;
}
__name(selectPermissionOption, "selectPermissionOption");
function selectRejectOption(options) {
  if (new Set(options.map((option) => option.optionId)).size !== options.length) {
    return void 0;
  }
  return (options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind === "reject_always"))?.optionId;
}
__name(selectRejectOption, "selectRejectOption");
function isExpectedExternalAgentCleanupExit(error) {
  return error instanceof Error && /^ACP child pid=\d+ exited uncleanly during shutdown \(code=[^,]+, signal=[^)]+\)$/.test(
    error.message
  );
}
__name(isExpectedExternalAgentCleanupExit, "isExpectedExternalAgentCleanupExit");
function isUnprovenExternalAgentTreeExit(error) {
  return error instanceof Error && /^ACP child pid=\d+ exited before its initial process-tree snapshot completed$/.test(
    error.message
  );
}
__name(isUnprovenExternalAgentTreeExit, "isUnprovenExternalAgentTreeExit");
var ExternalAgentTimeoutError = class extends Error {
  static {
    __name(this, "ExternalAgentTimeoutError");
  }
  constructor(timeoutMs) {
    super(`External ACP operation timed out after ${timeoutMs}ms`);
    this.name = "ExternalAgentTimeoutError";
  }
};
var AcpSubagentExecutor = class _AcpSubagentExecutor {
  constructor(params, child, emitter) {
    this.params = params;
    this.child = child;
    this.emitter = emitter;
    this.coreView = {
      getEventEmitter: /* @__PURE__ */ __name(() => emitter, "getEventEmitter"),
      modelConfig: {
        ...params.modelConfig,
        model: externalModelLabel(params.spec.command)
      }
    };
    void child.exited.then(
      () => this.fail(new Error(`external agent "${params.name}" exited`)),
      (error) => this.fail(error)
    );
  }
  static {
    __name(this, "AcpSubagentExecutor");
  }
  connection;
  sessionId = "";
  finalText = "";
  thoughtText = "";
  terminateMode = "ERROR" /* ERROR */;
  round = 0;
  durationMs = 0;
  turnStartedAt = 0;
  toolCalls = 0;
  toolSucceeded = 0;
  toolFailed = 0;
  executing = false;
  started = false;
  disposed = false;
  cancelled = false;
  disposePromise;
  provider;
  pendingPermissions = /* @__PURE__ */ new Map();
  tools = /* @__PURE__ */ new Map();
  toolNames = /* @__PURE__ */ new Map();
  finishedTools = /* @__PURE__ */ new Set();
  failure = new AbortController();
  coreView;
  static async create(params) {
    assertExternalAgentSpawnPlatformSupported();
    if (params.runConfig.max_turns !== void 0) {
      throw new Error("External ACP agents cannot enforce max_turns.");
    }
    const minutes = params.runConfig.max_time_minutes;
    if (minutes !== void 0 && (!Number.isFinite(minutes) || minutes <= 0 || minutes * 6e4 > 2147483647)) {
      throw new Error(
        "External ACP max_time_minutes must be positive, finite, and within the Node timer range."
      );
    }
    const child = spawn(params.spec.command, params.spec.args ?? [], {
      cwd: params.runtimeContext.getTargetDir(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      env: sanitizeChildEnv(process.env)
    });
    const tracked = new ProcessRegistry().reserve().attach(child, { ownsProcessTree: true });
    const executor = new _AcpSubagentExecutor(
      params,
      tracked,
      params.eventEmitter ?? new AgentEventEmitter()
    );
    child.on("error", (error) => executor.fail(error));
    child.stdin.on("error", (error) => executor.fail(error));
    child.stdout.on("error", (error) => executor.fail(error));
    const forwarder = createStderrForwarder({
      prefix: `[external-agent ${params.name}] `
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", forwarder.onData);
    child.stderr.on("end", forwarder.onEnd);
    child.stderr.on("error", () => {
    });
    try {
      executor.connection = new ClientSideConnection(
        () => executor.buildClient(),
        ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout)
        )
      );
      void executor.connection.closed.then(
        () => executor.fail(new Error("External ACP connection closed"))
      );
      await executor.wait(executor.connect(), INIT_TIMEOUT_MS);
      return executor;
    } catch (error) {
      await executor.dispose();
      throw error;
    }
  }
  buildClient() {
    return {
      sessionUpdate: /* @__PURE__ */ __name(async (params) => this.onSessionUpdate(params), "sessionUpdate"),
      requestPermission: /* @__PURE__ */ __name((params) => this.onRequestPermission(params), "requestPermission"),
      readTextFile: /* @__PURE__ */ __name(async () => {
        throw RequestError.methodNotFound("fs/read_text_file");
      }, "readTextFile"),
      writeTextFile: /* @__PURE__ */ __name(async () => {
        throw RequestError.methodNotFound("fs/write_text_file");
      }, "writeTextFile"),
      extMethod: /* @__PURE__ */ __name(async (method) => {
        throw RequestError.methodNotFound(method);
      }, "extMethod"),
      extNotification: /* @__PURE__ */ __name(async () => {
      }, "extNotification")
    };
  }
  async connect() {
    const initialized = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Unsupported external ACP protocol version");
    }
    const session = await this.connection.newSession({
      cwd: this.params.runtimeContext.getTargetDir(),
      mcpServers: []
    });
    if (!session.sessionId)
      throw new Error("External ACP agent returned no sessionId");
    this.sessionId = session.sessionId;
    const policy = resolvePermissionMode(
      this.params.permissionMode,
      this.params.approvalMode
    );
    const availableIds = session.modes?.availableModes.map((mode) => mode.id) ?? [];
    const modeId = selectPeerModeId(policy, availableIds);
    if (!modeId) {
      throw new Error(
        `External ACP agent does not advertise any mode for the host's ${policy} approval policy (advertised: ${availableIds.join(", ") || "none"})`
      );
    }
    await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
  }
  fail(error) {
    this.failure.abort(error);
    this.drainPermissions();
  }
  async wait(operation, timeoutMs, signal) {
    let timer;
    let onFailure = /* @__PURE__ */ __name(() => {
    }, "onFailure");
    let onAbort = /* @__PURE__ */ __name(() => {
    }, "onAbort");
    const stopped = new Promise((_resolve, reject) => {
      onFailure = /* @__PURE__ */ __name(() => reject(this.failure.signal.reason), "onFailure");
      onAbort = /* @__PURE__ */ __name(() => reject(signal?.reason ?? new Error("External agent cancelled")), "onAbort");
      this.failure.signal.addEventListener("abort", onFailure, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.failure.signal.aborted) onFailure();
      if (signal?.aborted) onAbort();
      if (timeoutMs !== void 0) {
        timer = setTimeout(
          () => reject(new ExternalAgentTimeoutError(timeoutMs)),
          timeoutMs
        );
      }
    });
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      clearTimeout(timer);
      this.failure.signal.removeEventListener("abort", onFailure);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  async execute(context, signal, options = {}) {
    if (context.get("initial_messages_override") !== void 0) {
      throw new Error(
        "External ACP agents cannot import in-process conversation history"
      );
    }
    const continuation = this.started;
    const system = continuation ? "" : renderSubagentSystemPrompt(
      this.params.promptConfig,
      context,
      this.params.runtimeContext
    );
    const task = String(context.get("task_prompt") ?? "Get Started!");
    await this.runTurn(
      [
        ...system ? [{ type: "text", text: system }] : [],
        { type: "text", text: task }
      ],
      signal,
      options,
      continuation ? [task] : void 0
    );
  }
  async executeExternalInputs(inputs, signal, options = {}) {
    if (inputs.length === 0) return;
    await this.runTurn(this.inputPrompt(inputs), signal, options, inputs);
  }
  inputPrompt(inputs) {
    return inputs.map((input) => ({
      type: "text",
      text: typeof input === "string" ? input : input.text
    }));
  }
  emitInputs(inputs) {
    for (const input of inputs) {
      this.emitter.emit("external_message" /* EXTERNAL_MESSAGE */, {
        subagentId: this.id,
        kind: typeof input === "string" ? "message" : input.kind,
        text: typeof input === "string" ? input : input.text,
        timestamp: Date.now()
      });
    }
  }
  async runTurn(prompt, signal, options = {}, inputs) {
    if (this.executing)
      throw new Error("External ACP agents do not support concurrent turns");
    if (this.disposed || this.failure.signal.aborted)
      throw new Error("External ACP agent is closed");
    this.executing = true;
    this.started = true;
    this.cancelled = false;
    this.finalText = "";
    this.thoughtText = "";
    this.terminateMode = "ERROR" /* ERROR */;
    if (options.resetStats !== false) {
      this.round = this.durationMs = this.toolCalls = this.toolSucceeded = this.toolFailed = 0;
    }
    this.tools.clear();
    this.toolNames.clear();
    this.finishedTools.clear();
    this.turnStartedAt = Date.now();
    const timeoutMs = this.params.runConfig.max_time_minutes === void 0 ? void 0 : this.params.runConfig.max_time_minutes * 6e4;
    const cancel = /* @__PURE__ */ __name(() => {
      this.cancelled = true;
      this.drainPermissions();
      void this.connection.cancel({ sessionId: this.sessionId }).catch(() => {
      });
    }, "cancel");
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    try {
      this.emitter.emit("start" /* START */, {
        subagentId: this.id,
        name: this.params.name,
        model: this.coreView.modelConfig.model,
        tools: [],
        timestamp: Date.now()
      });
      if (signal?.aborted) {
        this.terminateMode = "CANCELLED" /* CANCELLED */;
        return;
      }
      const entryRound = this.round;
      let next = prompt;
      do {
        this.round++;
        const remaining = timeoutMs === void 0 ? void 0 : Math.max(
          0,
          timeoutMs - this.durationMs - (Date.now() - this.turnStartedAt)
        );
        if (remaining !== void 0 && remaining <= 0) {
          this.terminateMode = "TIMEOUT" /* TIMEOUT */;
          break;
        }
        if (inputs && this.round === entryRound + 1) this.emitInputs(inputs);
        const result = await this.wait(
          this.connection.prompt({ sessionId: this.sessionId, prompt: next }),
          remaining,
          signal
        );
        this.terminateMode = this.stopMode(result.stopReason);
        if (this.terminateMode !== "GOAL" /* GOAL */) break;
        if (signal?.aborted) {
          this.terminateMode = "CANCELLED" /* CANCELLED */;
          break;
        }
        const remainingNext = timeoutMs === void 0 ? void 0 : Math.max(
          0,
          timeoutMs - this.durationMs - (Date.now() - this.turnStartedAt)
        );
        if (remainingNext !== void 0 && remainingNext <= 0) {
          this.terminateMode = "TIMEOUT" /* TIMEOUT */;
          break;
        }
        const queued = this.provider?.() ?? [];
        if (queued.length === 0) break;
        this.emitter.emit("round_text" /* ROUND_TEXT */, {
          subagentId: this.id,
          round: this.round,
          text: this.finalText,
          thoughtText: this.thoughtText,
          timestamp: Date.now()
        });
        this.finalText = "";
        this.thoughtText = "";
        this.emitInputs(queued);
        next = this.inputPrompt(queued);
      } while (!signal?.aborted);
      if (signal?.aborted) this.terminateMode = "CANCELLED" /* CANCELLED */;
    } catch (error) {
      timedOut = error instanceof ExternalAgentTimeoutError;
      this.terminateMode = signal?.aborted ? "CANCELLED" /* CANCELLED */ : timedOut ? "TIMEOUT" /* TIMEOUT */ : "ERROR" /* ERROR */;
      if (this.emitter.rawListeners("error" /* ERROR */).length > 0 && !signal?.aborted) {
        this.emitter.emit("error" /* ERROR */, {
          subagentId: this.id,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        });
      }
      await this.dispose();
      if (!signal?.aborted && !timedOut) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.durationMs += Date.now() - this.turnStartedAt;
      this.executing = false;
      this.drainPermissions();
      this.emitter.emit("round_text" /* ROUND_TEXT */, {
        subagentId: this.id,
        round: this.round,
        text: this.finalText,
        thoughtText: this.thoughtText,
        timestamp: Date.now()
      });
      this.flushOpenTools();
      this.emitter.emit("finish" /* FINISH */, {
        subagentId: this.id,
        terminateReason: this.terminateMode,
        rounds: this.round,
        totalDurationMs: this.durationMs,
        totalToolCalls: this.toolCalls,
        successfulToolCalls: this.toolSucceeded,
        failedToolCalls: this.toolFailed,
        timestamp: Date.now()
      });
    }
  }
  stopMode(reason) {
    switch (reason) {
      case "end_turn":
        return "GOAL" /* GOAL */;
      case "max_turn_requests":
        return "MAX_TURNS" /* MAX_TURNS */;
      case "cancelled":
        return "CANCELLED" /* CANCELLED */;
      case "refusal":
        return "ERROR" /* ERROR */;
      default:
        return "ERROR" /* ERROR */;
    }
  }
  get id() {
    return this.params.subagentId ?? this.params.name;
  }
  getFinalText() {
    return this.finalText;
  }
  getTerminateMode() {
    return this.terminateMode;
  }
  getCore() {
    return this.coreView;
  }
  setExternalMessageProvider(provider) {
    this.provider = provider;
  }
  // This executor deliberately does NOT implement `setExternalMessageWaiter` /
  // `setExternalMessageWaitPredicate`: ACP v1 has no mid-turn injection
  // primitive (no `session/steer`), so input that arrives while a prompt is in
  // flight cannot be delivered until that prompt resolves. Queued input is
  // drained between prompts via the provider above (next-turn-boundary
  // delivery). Implementing true mid-turn steering would require cancel +
  // re-prompt — re-billing the whole in-flight turn — which is a protocol/billing
  // decision, not a safe default. The delegation result surfaces this
  // limitation (see agent.ts EXTERNAL_MID_TURN_INPUT_NOTICE). (R3-6)
  getExecutionSummary() {
    return {
      rounds: this.round,
      totalDurationMs: this.durationMs + (this.executing ? Date.now() - this.turnStartedAt : 0),
      totalToolCalls: this.toolCalls,
      successfulToolCalls: this.toolSucceeded,
      failedToolCalls: this.toolFailed,
      successRate: this.toolCalls ? this.toolSucceeded / this.toolCalls * 100 : 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: []
    };
  }
  dispose() {
    this.disposed = true;
    this.fail(new Error("External ACP agent disposed"));
    return this.disposePromise ??= this.child.terminate().catch((error) => {
      if (isUnprovenExternalAgentTreeExit(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        debugLogger.warn(
          `External ACP agent process tree was not proven gone after disposal: ${detail}`
        );
        if (this.emitter.rawListeners("error" /* ERROR */).length > 0) {
          this.emitter.emit("error" /* ERROR */, {
            subagentId: this.id,
            error: `External agent process tree not proven gone after disposal: ${detail}`,
            timestamp: Date.now()
          });
        }
        return;
      }
      if (!isExpectedExternalAgentCleanupExit(error)) throw error;
    });
  }
  drainPermissions() {
    for (const cancel of this.pendingPermissions.values()) cancel();
    this.pendingPermissions.clear();
  }
  onSessionUpdate({ sessionId, update }) {
    if (sessionId !== this.sessionId || !this.executing || this.cancelled || this.disposed || this.failure.signal.aborted)
      return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const thought = update.sessionUpdate === "agent_thought_chunk";
        const text = update.content.type === "text" ? update.content.text : JSON.stringify(update.content);
        if (thought) this.thoughtText += text;
        else this.finalText += text;
        this.emitter.emit("stream_text" /* STREAM_TEXT */, {
          subagentId: this.id,
          round: this.round,
          text,
          thought,
          timestamp: Date.now()
        });
        break;
      }
      case "tool_call":
        this.updateTool(update);
        break;
      case "tool_call_update":
        this.updateTool(update);
        break;
      default:
        break;
    }
  }
  updateTool(update) {
    const callId = update.toolCallId;
    if (this.finishedTools.has(callId)) return;
    const previous = this.tools.get(callId);
    const tool = {
      toolCallId: callId,
      title: previous?.title ?? "External tool",
      ...previous,
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([, value]) => value !== null && value !== void 0
        )
      )
    };
    this.tools.set(callId, tool);
    const meta = tool._meta?.["claudeCode"];
    const reportedName = isRecord(meta) && typeof meta["toolName"] === "string" ? meta["toolName"] : tool.kind ?? "external_tool";
    const name = this.toolNames.get(callId) ?? reportedName;
    if (!previous) {
      this.toolNames.set(callId, name);
      this.toolCalls++;
      this.emitter.emit("tool_call" /* TOOL_CALL */, {
        subagentId: this.id,
        round: this.round,
        callId,
        name,
        args: isRecord(tool.rawInput) ? tool.rawInput : { input: tool.rawInput },
        description: tool.title,
        timestamp: Date.now()
      });
    }
    if (tool.status !== "completed" && tool.status !== "failed") return;
    this.finishedTools.add(callId);
    this.tools.delete(callId);
    const success = tool.status === "completed";
    if (success) this.toolSucceeded++;
    else this.toolFailed++;
    this.toolNames.delete(callId);
    const response = {
      input: tool.rawInput ?? null,
      toolName: reportedName,
      output: tool.rawOutput ?? null,
      content: tool.content ?? null,
      status: tool.status
    };
    const responseParts = [
      { functionResponse: { id: callId, name, response } }
    ];
    this.emitter.emit("tool_result" /* TOOL_RESULT */, {
      subagentId: this.id,
      round: this.round,
      callId,
      name,
      success,
      responseParts,
      resultDisplay: JSON.stringify(tool.rawOutput ?? tool.content ?? null),
      timestamp: Date.now()
    });
    this.emitter.emit("tool_responses_finalized" /* TOOL_RESPONSES_FINALIZED */, {
      subagentId: this.id,
      round: this.round,
      responses: [{ callId, responseParts }],
      timestamp: Date.now()
    });
  }
  /**
   * Emit a terminal TOOL_RESULT + TOOL_RESPONSES_FINALIZED for every tool call
   * still open when the turn ends. Cancel, timeout and peer crash all leave
   * entries in `this.tools`: `cancel()` sets `this.cancelled` before the peer's
   * own terminal `tool_call_update` can arrive (so `onSessionUpdate` drops it),
   * and the next `runTurn` clears the map. Without this flush three consumers
   * keep a false record — the inline frame and Web Shell row show the tool
   * executing forever (TOOL_RESULT is the only writer of their status), the
   * JSONL transcript holds a permanently unpaired `functionCall`
   * (TOOL_RESPONSES_FINALIZED is the only writer of its `tool_result`), and
   * FINISH's totals do not sum. The in-process sibling closes the same gap via
   * `onAllToolCallsComplete`.
   */
  flushOpenTools() {
    for (const [callId, tool] of this.tools) {
      const meta = tool._meta?.["claudeCode"];
      const reportedName = isRecord(meta) && typeof meta["toolName"] === "string" ? meta["toolName"] : tool.kind ?? "external_tool";
      const name = this.toolNames.get(callId) ?? reportedName;
      this.toolFailed++;
      const response = {
        input: tool.rawInput ?? null,
        toolName: reportedName,
        output: null,
        content: tool.content ?? null,
        status: "failed"
      };
      const responseParts = [
        { functionResponse: { id: callId, name, response } }
      ];
      this.emitter.emit("tool_result" /* TOOL_RESULT */, {
        subagentId: this.id,
        round: this.round,
        callId,
        name,
        success: false,
        responseParts,
        resultDisplay: JSON.stringify(tool.content ?? null),
        timestamp: Date.now()
      });
      this.emitter.emit("tool_responses_finalized" /* TOOL_RESPONSES_FINALIZED */, {
        subagentId: this.id,
        round: this.round,
        responses: [{ callId, responseParts }],
        timestamp: Date.now()
      });
    }
    this.tools.clear();
    this.toolNames.clear();
  }
  async onRequestPermission(params) {
    const cancelled = {
      outcome: { outcome: "cancelled" }
    };
    const runtime = this.params.runtimeContext;
    const callId = params.toolCall.toolCallId;
    const meta = params.toolCall._meta?.["claudeCode"];
    const name = isRecord(meta) && typeof meta["toolName"] === "string" ? meta["toolName"] : params.toolCall.kind ?? "external_tool";
    if (params.sessionId !== this.sessionId || !this.executing || this.cancelled || this.disposed || this.failure.signal.aborted || this.pendingPermissions.has(callId) || params.options.length === 0 || new Set(params.options.map((option) => option.optionId)).size !== params.options.length)
      return cancelled;
    if (name.replaceAll("_", "").toLowerCase() === "askuserquestion" || runtime.getShouldAvoidPermissionPrompts() || !runtime.isInteractive() && !runtime.getExperimentalZedIntegration() && runtime.getInputFormat() !== "stream-json" /* STREAM_JSON */ || this.emitter.rawListeners("tool_waiting_approval" /* TOOL_WAITING_APPROVAL */).length === 0) {
      const rejectOptionId = selectRejectOption(params.options);
      return rejectOptionId ? { outcome: { outcome: "selected", optionId: rejectOptionId } } : cancelled;
    }
    return new Promise((resolve) => {
      const finish = /* @__PURE__ */ __name((optionId) => {
        if (this.pendingPermissions.get(callId) !== deny) return;
        this.pendingPermissions.delete(callId);
        resolve(
          optionId ? { outcome: { outcome: "selected", optionId } } : cancelled
        );
      }, "finish");
      const deny = /* @__PURE__ */ __name(() => finish(), "deny");
      this.pendingPermissions.set(callId, deny);
      try {
        this.emitter.emit("tool_waiting_approval" /* TOOL_WAITING_APPROVAL */, {
          subagentId: this.id,
          round: this.round,
          callId,
          name,
          args: isRecord(params.toolCall.rawInput) ? params.toolCall.rawInput : {},
          description: params.toolCall.title ?? "External action",
          confirmationDetails: {
            type: "info",
            title: params.toolCall.title ?? "External action",
            // Carry the action's arguments so the user sees WHAT they are
            // authorizing — not just the option labels the dialog already
            // renders as buttons (R11-5). Bounded and control-stripped.
            prompt: describeExternalAction(params.toolCall),
            // The prompt is a foreign-process payload; render it as plain text,
            // never markdown — otherwise the dialog would eat glob `**` and
            // render links, misrepresenting what the user approves. (R11-5 fix)
            renderPromptAsPlainText: true,
            hideAlwaysAllow: true
          },
          respond: /* @__PURE__ */ __name(async (outcome) => finish(
            selectPermissionOption(params.options, outcome) ?? // An explicit user rejection of THIS tool must deny the tool,
            // not cancel the whole turn: `selectPermissionOption` maps
            // Cancel to undefined, and ACP `cancelled` ends the prompt turn
            // (abandoning the remaining work and billing a fresh prompt to
            // re-delegate). Select the peer's `reject_once` option so the
            // turn continues without this one action, matching the dialog's
            // "suggest changes" promise and the in-process sibling. Fall
            // back to `cancelled` only when no reject option is selectable.
            (outcome === "cancel" /* Cancel */ ? selectRejectOption(params.options) : void 0)
          ), "respond"),
          timestamp: Date.now()
        });
      } catch {
        deny();
      }
    });
  }
};
var acpExternalAgentExecutor = {
  create: /* @__PURE__ */ __name((params) => AcpSubagentExecutor.create(params), "create")
};

export {
  externalModelLabel,
  describeExternalAction,
  assertExternalAgentSpawnPlatformSupported,
  resolvePermissionMode,
  selectPeerModeId,
  optionKindForOutcome,
  selectPermissionOption,
  selectRejectOption,
  isExpectedExternalAgentCleanupExit,
  isUnprovenExternalAgentTreeExit,
  acpExternalAgentExecutor
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
