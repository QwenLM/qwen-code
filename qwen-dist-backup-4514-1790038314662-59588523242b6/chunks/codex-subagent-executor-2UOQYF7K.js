// Force strict mode and setup for ESM
"use strict";
import {
  assertExternalAgentSpawnPlatformSupported,
  isExpectedExternalAgentCleanupExit,
  isUnprovenExternalAgentTreeExit
} from "./chunk-IH4A23W3.js";
import {
  ProcessRegistry
} from "./chunk-L7TJUPNR.js";
import "./chunk-YYNEF4AU.js";
import "./chunk-LYD3T3H7.js";
import "./chunk-SIUR4U2P.js";
import "./chunk-YXHY6BKS.js";
import "./chunk-6PLDPT2C.js";
import "./chunk-M5GB774H.js";
import "./chunk-3VUENPWF.js";
import "./chunk-IJOS26LH.js";
import "./chunk-47GVX3K4.js";
import "./chunk-GELRJXE2.js";
import "./chunk-32CM56LO.js";
import "./chunk-MC2RYJMU.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-DJLCK66M.js";
import "./chunk-M5YIHMXP.js";
import "./chunk-7MEBNX4M.js";
import "./chunk-PWRMILYW.js";
import "./chunk-LAE6RY3L.js";
import "./chunk-FHWIBVQQ.js";
import "./chunk-FXPP7VLM.js";
import "./chunk-7PQ65Z5F.js";
import "./chunk-ZPJWUGCS.js";
import "./chunk-O4A2B6V2.js";
import "./chunk-CAAUC2LP.js";
import "./chunk-SQRZJD25.js";
import "./chunk-NCXNBDGJ.js";
import "./chunk-DJYHML3Y.js";
import "./chunk-HQI463JG.js";
import "./chunk-V2XJJTAB.js";
import "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-PU756QJZ.js";
import "./chunk-RSFNJ6UU.js";
import "./chunk-JYGESWZM.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import {
  AgentEventEmitter,
  renderSubagentSystemPrompt
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import {
  sanitizeChildEnv
} from "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
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
import "./chunk-QPTE6BKL.js";
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
import "./chunk-VNOVK4I7.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
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
import "./chunk-6DB6UHY3.js";
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
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
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

// packages/cli/src/external-agents/codex-subagent-executor.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
var debugLogger = createDebugLogger("EXTERNAL_AGENT");
var CodexInterruption = class extends Error {
  constructor(mode) {
    super(
      mode === "TIMEOUT" /* TIMEOUT */ ? "Codex task exceeded its time limit." : "Codex task cancelled."
    );
    this.mode = mode;
  }
  static {
    __name(this, "CodexInterruption");
  }
};
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex returned an invalid protocol object.");
  }
  return value;
}
__name(object, "object");
function id(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("Codex returned an invalid thread or turn ID.");
  }
  return value;
}
__name(id, "id");
async function runCodex(params, prompt, sandbox, signal) {
  if (signal.aborted) throw new CodexInterruption("CANCELLED" /* CANCELLED */);
  const env = sanitizeChildEnv(process.env);
  delete env["CODEX_THREAD_ID"];
  delete env["CLAUDECODE"];
  delete env["NODE_OPTIONS"];
  const child = spawn(
    params.spec.command,
    params.spec.args ?? ["app-server", "--stdio"],
    {
      cwd: params.runtimeContext.getTargetDir(),
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true
    }
  );
  const tracked = new ProcessRegistry().reserve().attach(child, {
    ownsProcessTree: true
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = /* @__PURE__ */ new Map();
  let sequence = 0;
  let threadId;
  let turnId;
  let finalAnswer;
  let unphasedAnswer;
  let terminal = false;
  let exitDrainTimer;
  let fail;
  const failure = new Promise((_resolve, reject) => {
    fail = reject;
  });
  let complete;
  const completed = new Promise((resolve) => {
    complete = resolve;
  });
  const write = /* @__PURE__ */ __name((frame) => {
    child.stdin.write(`${JSON.stringify(frame)}
`);
  }, "write");
  const request = /* @__PURE__ */ __name((method, parameters) => {
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      write({ id: requestId, method, params: parameters });
    });
  }, "request");
  const abort = /* @__PURE__ */ __name(() => {
    if (threadId && turnId) {
      void request("turn/interrupt", { threadId, turnId }).catch(() => {
      });
    }
    fail(new CodexInterruption("CANCELLED" /* CANCELLED */));
  }, "abort");
  signal.addEventListener("abort", abort, { once: true });
  child.once("error", (error) => {
    fail(
      new Error(
        error.code === "ENOENT" ? `Cannot start ${params.spec.command}. Install Codex and make it available on PATH.` : `Cannot start Codex: ${error.code ?? "process error"}`
      )
    );
  });
  const onExit = /* @__PURE__ */ __name((code, exitSignal) => {
    exitDrainTimer = setTimeout(
      () => fail(
        new Error(`Codex exited before completion (${exitSignal ?? code}).`)
      ),
      1e4
    );
  }, "onExit");
  child.once("exit", onExit);
  child.stdin.on("error", () => fail(new Error("Codex input stream closed.")));
  child.stdout.on(
    "error",
    () => fail(new Error("Codex output stream failed."))
  );
  const associateTurn = /* @__PURE__ */ __name((value) => {
    const observed = id(value);
    if (turnId && observed !== turnId)
      throw new Error("Codex returned another turn.");
    turnId = observed;
  }, "associateTurn");
  lines.on("line", (line) => {
    if (terminal && pending.size === 0) return;
    try {
      let frame;
      try {
        frame = object(JSON.parse(line));
      } catch (error) {
        if (terminal) return;
        throw error;
      }
      if (typeof frame["method"] !== "string") {
        const reply = pending.get(frame["id"]);
        if (!reply) return;
        pending.delete(frame["id"]);
        if (frame["error"])
          reply.reject(new Error("Codex rejected an app-server request."));
        else reply.resolve(object(frame["result"]));
        return;
      }
      if (terminal) return;
      const method = frame["method"];
      const parameters = object(frame["params"] ?? {});
      if (frame["id"] !== void 0) {
        let result;
        switch (method) {
          case "item/commandExecution/requestApproval":
          case "item/fileChange/requestApproval": {
            const available = parameters["availableDecisions"];
            const decision = Array.isArray(available) ? available.includes("decline") ? "decline" : available.includes("cancel") ? "cancel" : void 0 : "decline";
            if (!decision)
              throw new Error("Codex offered no unattended rejection.");
            result = { decision };
            break;
          }
          case "item/permissions/requestApproval":
            result = { permissions: {}, scope: "turn" };
            break;
          case "item/tool/requestUserInput":
            result = { answers: {} };
            break;
          case "mcpServer/elicitation/request":
            result = { action: "decline", content: null, _meta: null };
            break;
          default:
            write({
              id: frame["id"],
              error: {
                code: -32601,
                message: "Unsupported unattended request."
              }
            });
            throw new Error(
              `Codex requested unsupported interaction: ${method}`
            );
        }
        write({ id: frame["id"], result });
        return;
      }
      if (!threadId || parameters["threadId"] !== threadId) return;
      if (method === "turn/started" || method === "turn/completed") {
        const turn = object(parameters["turn"]);
        associateTurn(turn["id"]);
        if (method === "turn/completed") {
          terminal = true;
          complete(turn);
        }
      } else if (method === "item/completed") {
        associateTurn(parameters["turnId"]);
        const item = object(parameters["item"]);
        if (item["type"] !== "agentMessage") return;
        if (typeof item["text"] !== "string")
          throw new Error("Codex returned an invalid message.");
        if (item["phase"] === "final_answer") finalAnswer = item["text"];
        else if (item["phase"] == null) unphasedAnswer = item["text"];
      }
    } catch (error) {
      fail(
        error instanceof Error ? error : new Error("Invalid Codex protocol frame.")
      );
    }
  });
  lines.on("close", () => {
    if (!terminal || pending.size > 0)
      fail(new Error("Codex protocol closed before completion."));
  });
  const initTimer = setTimeout(
    () => fail(new Error("Codex initialization timed out.")),
    1e4
  );
  const minutes = params.runConfig.max_time_minutes;
  const executionTimer = minutes === void 0 ? void 0 : setTimeout(
    () => fail(new CodexInterruption("TIMEOUT" /* TIMEOUT */)),
    minutes * 6e4
  );
  const run = /* @__PURE__ */ __name(async () => {
    await request("initialize", {
      clientInfo: { name: "qwen-code", version: "1.0.0" },
      capabilities: { experimentalApi: false }
    });
    write({ method: "initialized" });
    const started = await request("thread/start", {
      cwd: params.runtimeContext.getTargetDir(),
      ephemeral: true,
      approvalPolicy: "never",
      sandbox
    });
    const thread = object(started["thread"]);
    threadId = id(thread["id"]);
    if (thread["ephemeral"] !== true)
      throw new Error("Codex did not create an ephemeral thread.");
    clearTimeout(initTimer);
    const startedTurn = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }]
    });
    associateTurn(object(startedTurn["turn"])["id"]);
    const turn = await completed;
    if (turn["status"] !== "completed")
      throw new Error(
        `Codex turn ended with status ${String(turn["status"])}.`
      );
    const answer = finalAnswer ?? unphasedAnswer;
    if (!answer?.trim())
      throw new Error("Codex completed without a final answer.");
    return answer;
  }, "run");
  let completedAnswer;
  let interruption;
  try {
    completedAnswer = await Promise.race([run(), failure]);
    return completedAnswer;
  } catch (error) {
    if (error instanceof CodexInterruption) interruption = error;
    throw error;
  } finally {
    clearTimeout(initTimer);
    clearTimeout(executionTimer);
    clearTimeout(exitDrainTimer);
    child.removeListener("exit", onExit);
    signal.removeEventListener("abort", abort);
    lines.close();
    for (const reply of pending.values())
      reply.reject(new Error("Codex connection closed."));
    pending.clear();
    await tracked.terminate().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (isUnprovenExternalAgentTreeExit(error)) {
        const diagnostic = `Codex process tree not proven gone after cleanup: ${detail}`;
        debugLogger.warn(diagnostic);
        if (params.eventEmitter?.rawListeners("error" /* ERROR */).length) {
          params.eventEmitter.emit("error" /* ERROR */, {
            subagentId: params.subagentId ?? params.name,
            error: diagnostic,
            timestamp: Date.now()
          });
        }
      } else if (!isExpectedExternalAgentCleanupExit(error)) {
        if (interruption) {
          interruption.message += `

Codex cleanup failed: ${detail}`;
          throw interruption;
        }
        throw new Error(
          `Codex cleanup failed: ${detail}` + (completedAnswer === void 0 ? "" : `

Completed Codex answer:
${completedAnswer}`)
        );
      }
    }).finally(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    });
  }
}
__name(runCodex, "runCodex");
var CodexSubagentExecutor = class {
  constructor(params) {
    this.params = params;
    assertExternalAgentSpawnPlatformSupported();
    if (params.spec.kind !== "codex")
      throw new Error("Expected a Codex executor.");
    if (!params.runtimeContext.isTrustedFolder())
      throw new Error("Codex agents require a trusted workspace.");
    const minutes = params.runConfig.max_time_minutes;
    if (params.runConfig.max_turns !== void 0 || minutes !== void 0 && (!Number.isFinite(minutes) || minutes <= 0 || minutes * 6e4 > 2147483647)) {
      throw new Error(
        "Codex requires a valid time limit and does not support max_turns."
      );
    }
    switch (params.approvalMode ?? "default") {
      case "default":
      case "plan":
      case "auto":
        this.sandbox = "read-only";
        break;
      case "auto-edit":
        this.sandbox = "workspace-write";
        break;
      case "yolo":
        this.sandbox = "danger-full-access";
        break;
      default:
        throw new Error(
          `Codex does not support approval mode ${params.approvalMode}.`
        );
    }
    this.emitter = params.eventEmitter ?? new AgentEventEmitter();
    this.core = {
      getEventEmitter: /* @__PURE__ */ __name(() => this.emitter, "getEventEmitter"),
      modelConfig: { model: "external-codex:codex" }
    };
  }
  static {
    __name(this, "CodexSubagentExecutor");
  }
  continuationBlockedReason = "Codex agents are one-shot: start a new Agent task instead of sending messages or resuming.";
  controller = new AbortController();
  emitter;
  core;
  sandbox;
  execution;
  finalText = "";
  terminateMode = "ERROR" /* ERROR */;
  durationMs = 0;
  execute(context, signal) {
    if (this.execution)
      return Promise.reject(new Error(this.continuationBlockedReason));
    this.execution = this.run(context, signal);
    return this.execution;
  }
  async run(context, signal) {
    const start = Date.now();
    const subagentId = this.params.subagentId ?? this.params.name;
    const abort = /* @__PURE__ */ __name(() => this.controller.abort(signal?.reason), "abort");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      if (this.controller.signal.aborted)
        throw new CodexInterruption("CANCELLED" /* CANCELLED */);
      if (context.get("initial_messages_override") !== void 0)
        throw new Error("Codex agents cannot import conversation history.");
      this.emitter.emit("start" /* START */, {
        subagentId,
        name: this.params.name,
        model: this.core.modelConfig.model,
        tools: [],
        timestamp: Date.now()
      });
      const system = renderSubagentSystemPrompt(
        this.params.promptConfig,
        context,
        this.params.runtimeContext
      );
      const task = String(context.get("task_prompt") ?? "Get Started!");
      this.finalText = await runCodex(
        { ...this.params, eventEmitter: this.emitter },
        [system, task].filter(Boolean).join("\n\n"),
        this.sandbox,
        this.controller.signal
      );
      this.terminateMode = this.controller.signal.aborted ? "CANCELLED" /* CANCELLED */ : "GOAL" /* GOAL */;
    } catch (error) {
      this.terminateMode = error instanceof CodexInterruption ? error.mode : "ERROR" /* ERROR */;
      this.finalText = error instanceof Error ? error.message : String(error);
      if (!(error instanceof CodexInterruption)) throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.durationMs = Date.now() - start;
      this.emitter.emit("round_text" /* ROUND_TEXT */, {
        subagentId,
        round: 1,
        text: this.finalText,
        thoughtText: "",
        timestamp: Date.now()
      });
      this.emitter.emit("finish" /* FINISH */, {
        subagentId,
        terminateReason: this.terminateMode,
        rounds: 1,
        totalDurationMs: this.durationMs,
        totalToolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        timestamp: Date.now()
      });
    }
  }
  async executeExternalInputs(inputs) {
    if (inputs.length) throw new Error(this.continuationBlockedReason);
  }
  setExternalMessageProvider() {
    throw new Error(this.continuationBlockedReason);
  }
  getFinalText() {
    return this.finalText;
  }
  getTerminateMode() {
    return this.terminateMode;
  }
  getCore() {
    return this.core;
  }
  getExecutionSummary() {
    return {
      rounds: this.execution ? 1 : 0,
      totalDurationMs: this.durationMs,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: []
    };
  }
  async dispose() {
    this.controller.abort();
    await this.execution?.catch(() => {
    });
  }
};
var codexExternalAgentExecutor = {
  create: /* @__PURE__ */ __name(async (params) => new CodexSubagentExecutor(params), "create")
};
export {
  codexExternalAgentExecutor
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
