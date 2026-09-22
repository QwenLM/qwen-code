// Force strict mode and setup for ESM
"use strict";
import {
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_MAX_SOURCE_CHARS,
  CODE_MODE_TIMEOUT_MS,
  FrameDecoder,
  encodeFrame
} from "./chunk-U6H3XTFA.js";
import {
  resolveBundleDir
} from "./chunk-ACHCT36C.js";
import {
  CodeModeTurnTerminated,
  getToolCallRuntime
} from "./chunk-CFMZLE3L.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/exec.ts
init_esbuild_shims();

// packages/core/src/code-mode/host-client.ts
init_esbuild_shims();
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var CODE_MODE_HOST_STARTUP_GRACE_MS = 3e4;
var CodeModeExecutionError = class extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
    this.name = "CodeModeExecutionError";
  }
  static {
    __name(this, "CodeModeExecutionError");
  }
};
function hostCommand() {
  const currentFile = fileURLToPath(import.meta.url);
  if (currentFile.endsWith(".ts")) {
    const require2 = createRequire(import.meta.url);
    return {
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(require2.resolve("tsx")).href,
        path.join(path.dirname(currentFile), "host.ts")
      ]
    };
  }
  const sibling = path.join(path.dirname(currentFile), "host.js");
  if (existsSync(sibling)) {
    return { command: process.execPath, args: [sibling] };
  }
  return {
    command: process.execPath,
    args: [path.join(resolveBundleDir(import.meta.url), "codeModeHost.js")]
  };
}
__name(hostCommand, "hostCommand");
function childEnvironment() {
  const env = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP"
  ]) {
    const value = process.env[name];
    if (value !== void 0) env[name] = value;
  }
  return env;
}
__name(childEnvironment, "childEnvironment");
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
}
__name(terminate, "terminate");
function boundedToolResult(id, result) {
  const bounded = {
    ...result,
    output: result.output.slice(0, CODE_MODE_MAX_OUTPUT_CHARS)
  };
  try {
    encodeFrame({ type: "tool_result", id, ok: true, result: bounded });
    return bounded;
  } catch {
  }
  return { ...bounded, content: void 0 };
}
__name(boundedToolResult, "boundedToolResult");
function abortReason(signal) {
  return signal.reason ?? new Error("Code mode execution was cancelled.");
}
__name(abortReason, "abortReason");
async function executeCodeMode(source, plan, runtime, signal, options = {}) {
  if (source.length > CODE_MODE_MAX_SOURCE_CHARS) {
    throw new Error("JavaScript source exceeds the size limit.");
  }
  if (signal.aborted) throw abortReason(signal);
  const command = hostCommand();
  const timeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? CODE_MODE_TIMEOUT_MS),
    CODE_MODE_TIMEOUT_MS
  );
  const maxOutputChars = Math.min(
    Math.max(1, options.maxOutputChars ?? CODE_MODE_MAX_OUTPUT_CHARS),
    CODE_MODE_MAX_OUTPUT_CHARS
  );
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment()
  });
  const byJsName = new Map(
    plan.bindings.map((item) => [item.jsName, item.name])
  );
  const decoder = new FrameDecoder();
  const nestedControllers = /* @__PURE__ */ new Map();
  let stderr = "";
  let completed;
  let terminating = false;
  let protocolError;
  let wallTimer;
  let wallRemainingMs = timeoutMs + CODE_MODE_HOST_STARTUP_GRACE_MS;
  let wallDeadline = Date.now() + wallRemainingMs;
  let wallPaused = false;
  const send = /* @__PURE__ */ __name((message) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(encodeFrame(message));
    }
  }, "send");
  const cancelNested = /* @__PURE__ */ __name((reason) => {
    for (const controller of nestedControllers.values())
      controller.abort(reason);
    nestedControllers.clear();
  }, "cancelNested");
  const onAbort = /* @__PURE__ */ __name(() => {
    cancelNested(abortReason(signal));
    terminate(child);
  }, "onAbort");
  const onWallTimeout = /* @__PURE__ */ __name(() => {
    protocolError = new Error(
      `JavaScript execution timed out after ${timeoutMs + CODE_MODE_HOST_STARTUP_GRACE_MS}ms (guest budget ${timeoutMs}ms; the code-mode host may not have finished starting).`
    );
    cancelNested(protocolError);
    terminate(child);
  }, "onWallTimeout");
  const startWallTimer = /* @__PURE__ */ __name(() => {
    wallDeadline = Date.now() + wallRemainingMs;
    wallTimer = setTimeout(onWallTimeout, wallRemainingMs);
  }, "startWallTimer");
  const pauseWallTimer = /* @__PURE__ */ __name(() => {
    if (wallPaused) return;
    wallRemainingMs = Math.max(1, wallDeadline - Date.now());
    if (wallTimer) clearTimeout(wallTimer);
    wallTimer = void 0;
    wallPaused = true;
  }, "pauseWallTimer");
  const resumeWallTimer = /* @__PURE__ */ __name(() => {
    if (!wallPaused || completed || protocolError) return;
    wallPaused = false;
    startWallTimer();
  }, "resumeWallTimer");
  signal.addEventListener("abort", onAbort, { once: true });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8192)
      stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
  });
  child.stdin.on("error", (error) => {
    if (!completed && !protocolError) protocolError = error;
  });
  child.stdout.on("data", (chunk) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.type === "complete") {
          completed = message;
          cancelNested(
            new Error(
              "The exec program finished before this call was awaited."
            )
          );
          child.stdin.end();
          continue;
        }
        if (message.type === "error") {
          protocolError = new CodeModeExecutionError(message.error, {
            output: message.output ?? "",
            ...message.content ? { content: message.content } : {}
          });
          cancelNested(protocolError);
          child.stdin.end();
          continue;
        }
        if (terminating) continue;
        const actualName = byJsName.get(message.name);
        if (!actualName) {
          send({
            type: "tool_result",
            id: message.id,
            ok: false,
            error: `Tool "${message.name}" is not available in code mode.`
          });
          continue;
        }
        const controller = new AbortController();
        if (nestedControllers.size === 0) pauseWallTimer();
        nestedControllers.set(message.id, controller);
        void runtime.dispatch(actualName, message.args, controller.signal).then(
          (result) => send({
            type: "tool_result",
            id: message.id,
            ok: true,
            result: boundedToolResult(message.id, result)
          })
        ).catch((error) => {
          if (error instanceof CodeModeTurnTerminated) {
            if (!terminating) {
              terminating = true;
              send({ type: "terminate" });
            }
            return;
          }
          send({
            type: "tool_result",
            id: message.id,
            ok: false,
            error: (error instanceof Error ? error.message : String(error)).slice(0, CODE_MODE_MAX_OUTPUT_CHARS)
          });
        }).finally(() => {
          nestedControllers.delete(message.id);
          if (nestedControllers.size === 0) resumeWallTimer();
        });
      }
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
      terminate(child);
    }
  });
  startWallTimer();
  try {
    send({
      type: "execute",
      source,
      tools: plan.bindings.map(({ name, jsName, description, deferred }) => ({
        name,
        jsName,
        description,
        deferred
      })),
      timeoutMs,
      maxOutputChars
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    signal.removeEventListener("abort", onAbort);
    cancelNested(new Error("Code mode runtime stopped."));
    terminate(child);
  }
  if (signal.aborted) throw abortReason(signal);
  if (protocolError) throw protocolError;
  if (!completed) {
    throw new Error(
      `Code mode host exited without a result${stderr ? `: ${stderr}` : "."}`
    );
  }
  return {
    output: completed.output,
    ...completed.value === void 0 ? {} : { value: completed.value },
    ...completed.content === void 0 ? {} : { content: completed.content }
  };
}
__name(executeCodeMode, "executeCodeMode");

// packages/core/src/code-mode/output.ts
init_esbuild_shims();
var EXEC_MAX_OUTPUT_CHARS = 32e3;
function boundCodeModeOutput(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = "\n\u2026 code mode output truncated \u2026\n";
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - marker.length) / 2);
  const tail = maxChars - marker.length - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}
__name(boundCodeModeOutput, "boundCodeModeOutput");

// packages/core/src/tools/exec.ts
var ExecInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "ExecInvocation");
  }
  getDescription() {
    return "Execute isolated JavaScript with access to registered tools.";
  }
  async execute(signal) {
    const runtime = getToolCallRuntime();
    if (!runtime) {
      throw new Error(
        "exec is unavailable outside the audited tool-call runtime."
      );
    }
    const plan = this.config.getToolRegistry().getCodeModeBindingPlan(
      runtime.allowedToolNames ? new Set(runtime.allowedToolNames) : void 0
    );
    const toolResults = [];
    const media = [];
    let retainedOmniMedia = false;
    const metadata = {};
    const retainedTools = /* @__PURE__ */ new Set([
      ToolNames.SKILL,
      ToolNames.UPDATE_GOAL,
      "capture_screen_context"
    ]);
    let skillAttempted = false;
    const clearSkillTracking = /* @__PURE__ */ __name(() => {
      const skill = this.config.getToolRegistry().getTool(ToolNames.SKILL);
      if (skill && "clearLoadedSkills" in skill && typeof skill.clearLoadedSkills === "function") {
        skill.clearLoadedSkills();
      }
    }, "clearSkillTracking");
    const active = /* @__PURE__ */ new Set();
    let goalBarrier = Promise.resolve();
    const contextRuntime = {
      ...runtime,
      dispatch: /* @__PURE__ */ __name((name, args, nestedSignal, onResult) => {
        const predecessors = name === ToolNames.UPDATE_GOAL ? Promise.allSettled([...active]) : goalBarrier;
        const task = (async () => {
          await predecessors;
          if (metadata.terminateTurn) throw new CodeModeTurnTerminated();
          if (nestedSignal.aborted) throw nestedSignal.reason;
          if (name === ToolNames.SKILL) skillAttempted = true;
          const result2 = await runtime.dispatch(
            name,
            args,
            nestedSignal,
            (response) => {
              onResult?.(response);
              if (name === ToolNames.SKILL && (signal.aborted || nestedSignal.aborted || response.executionStatus === "cancelled")) {
                clearSkillTracking();
              }
              const native = response.responseParts.find(
                (part) => part.functionResponse
              )?.functionResponse;
              if (signal.aborted || nestedSignal.aborted || response.error || response.executionStatus === "cancelled" || response.executionStatus === "error" || native?.response?.["error"])
                return;
              if ("modelOverride" in response)
                metadata.modelOverride = response.modelOverride;
              if (response.terminateTurn) metadata.terminateTurn = true;
              const nestedParts = native?.parts ?? [];
              const hasOmniMedia = this.config.isOmniEnabled() && nestedParts.some(
                (part) => part.fileData || part.text !== void 0
              );
              if (retainedTools.has(name) || hasOmniMedia) {
                toolResults.push({
                  name,
                  args,
                  output: native?.response?.["output"]
                });
                if (hasOmniMedia) {
                  retainedOmniMedia = true;
                  media.push(...nestedParts);
                } else {
                  for (const part of nestedParts) {
                    if (part.inlineData)
                      media.push({ inlineData: part.inlineData });
                    if (part.fileData) media.push({ fileData: part.fileData });
                  }
                }
              }
            }
          );
          if (metadata.terminateTurn) throw new CodeModeTurnTerminated();
          if (name === "capture_screen_context") {
            const { content: _content, ...textResult } = result2;
            return textResult;
          }
          return result2;
        })();
        active.add(task);
        const settled = task.then(
          () => {
            active.delete(task);
          },
          () => {
            active.delete(task);
          }
        );
        if (name === ToolNames.UPDATE_GOAL) goalBarrier = settled;
        return task;
      }, "dispatch")
    };
    let result;
    let failure;
    try {
      result = await executeCodeMode(
        this.params.source,
        plan,
        contextRuntime,
        signal
      );
    } catch (error) {
      if (skillAttempted && (signal.aborted || !toolResults.some((result2) => result2.name === ToolNames.SKILL))) {
        clearSkillTracking();
      }
      if (signal.aborted) throw error;
      result = error instanceof CodeModeExecutionError ? error.result : { output: "" };
      failure = error instanceof Error ? error.message : String(error);
    }
    const sections = [];
    if (result.output) sections.push(result.output);
    if (result.value !== void 0)
      sections.push(`Return value: ${JSON.stringify(result.value)}`);
    if (failure !== void 0) sections.push(`Script error:
${failure}`);
    const output = boundCodeModeOutput(
      sections.join("\n") || "JavaScript completed successfully.",
      EXEC_MAX_OUTPUT_CHARS
    );
    const retained = toolResults.length ? JSON.stringify({ toolResults }) : "";
    const display = retained ? `${retained}
${output}` : output;
    const llmContent = [{ text: display }, ...media];
    for (const item of result.content ?? []) {
      llmContent.push({
        inlineData: {
          mimeType: item.mimeType,
          data: item.data
        }
      });
    }
    return {
      llmContent: retainedOmniMedia ? [
        {
          functionResponse: {
            id: runtime.parentCallId,
            name: ToolNames.EXEC,
            response: { output: display },
            parts: llmContent.slice(1)
          }
        }
      ] : llmContent,
      returnDisplay: display,
      ...metadata,
      persistedOutputFiles: [],
      ...failure === void 0 || toolResults.length > 0 ? {} : {
        error: { message: output, type: "execution_failed" /* EXECUTION_FAILED */ }
      }
    };
  }
};
var ExecTool = class extends BaseDeclarativeTool {
  constructor(config) {
    super(
      ToolNames.EXEC,
      ToolDisplayNames.EXEC,
      "Execute JavaScript in an isolated runtime.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "JavaScript source to execute."
          }
        },
        required: ["source"],
        additionalProperties: false
      },
      false,
      false,
      false,
      true
    );
    this.config = config;
  }
  static {
    __name(this, "ExecTool");
  }
  get maxOutputChars() {
    return Number.POSITIVE_INFINITY;
  }
  createInvocation(params) {
    return new ExecInvocation(this.config, params);
  }
};
export {
  ExecTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
