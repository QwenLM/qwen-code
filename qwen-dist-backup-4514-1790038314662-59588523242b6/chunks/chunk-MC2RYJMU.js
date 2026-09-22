// Force strict mode and setup for ESM
"use strict";
import {
  MAX_SUB_SESSION_PROMPT_CHARS
} from "./chunk-LJZSMWOH.js";
import {
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  isValidCronTaskRoutingId
} from "./chunk-C4FISGDN.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/create-sub-session.ts
init_esbuild_shims();
var DAEMON_ONLY_MESSAGE = "create_sub_session is only available when running under `qwen serve` (daemon mode). There is no session bridge in this environment, so a sub-session cannot be spawned.";
var CANCELLED = Symbol("create_sub_session:cancelled");
async function raceCancellation(start, signal) {
  if (signal.aborted) return CANCELLED;
  const spawn = start();
  void spawn.catch(() => {
  });
  return new Promise((resolve, reject) => {
    const onAbort = /* @__PURE__ */ __name(() => resolve(CANCELLED), "onAbort");
    signal.addEventListener("abort", onAbort, { once: true });
    spawn.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
__name(raceCancellation, "raceCancellation");
var CreateSubSessionInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "CreateSubSessionInvocation");
  }
  getDescription() {
    const mode = this.params.completion ?? "first-turn";
    const raw = this.params.name ?? this.params.prompt;
    const cleaned = raw.replace(/[\r\n\t\x00-\x1f]/g, " ").trim();
    const label = cleaned.length > 80 ? cleaned.slice(0, 77) + "\u2026" : cleaned;
    return `[${mode}] ${label}`;
  }
  /**
   * `create_sub_session` runs a model-authored prompt with full tool access in
   * a fresh session — the same privileged-sink shape as `cron_create`,
   * `send_message` and `task_create`, which all return `'ask'`. The L3 default
   * must NOT be `'allow'`: AUTO mode short-circuits before the L5 classifier
   * when `finalPermission === 'allow'`, and DEFAULT mode skips confirmation,
   * so the delegated prompt would never be reviewed. `'ask'` lets AUTO route
   * the call through the classifier, which resolves it without a human.
   */
  async getDefaultPermission() {
    return "ask";
  }
  async execute(signal) {
    const spawner = this.config.getSubSessionSpawner();
    if (!spawner) {
      return {
        llmContent: DAEMON_ONLY_MESSAGE,
        returnDisplay: "Unavailable (daemon-only)",
        error: { message: DAEMON_ONLY_MESSAGE }
      };
    }
    const completion = this.params.completion ?? "first-turn";
    const prompt = this.params.prompt.trim();
    let spawnStarted = false;
    try {
      const res = await raceCancellation(() => {
        spawnStarted = true;
        return spawner({
          prompt,
          completion,
          ...this.params.model ? { model: this.params.model } : {},
          ...this.params.name ? { name: this.params.name } : {}
        });
      }, signal);
      if (res === CANCELLED) {
        const message = spawnStarted ? "create_sub_session was cancelled. A sub-session may already have been created; it runs independently and is not cancelled." : "create_sub_session was cancelled before it started. No sub-session was created.";
        return { llmContent: message, returnDisplay: "Cancelled" };
      }
      const sessionLink = `[\u{1F9F5} ${res.sessionId.slice(0, 8)}](qwen-session://${res.sessionId})`;
      const parentWarning = res.parentSessionPersisted === false ? " Note: the parent-session link could not be persisted and is live-only \u2014 it will not survive a daemon restart." : "";
      if (completion === "sent") {
        return {
          llmContent: `Sub-session ${sessionLink} created and the prompt was dispatched. It runs independently \u2014 this call did not wait for a result.${parentWarning}`,
          returnDisplay: `${sessionLink} started`
        };
      }
      const stop = res.stopReason ? ` (stopReason: ${res.stopReason})` : "";
      const body = res.result && res.result.length > 0 ? res.result : `Sub-session ${sessionLink} completed its first turn but produced no text output.`;
      return {
        llmContent: `Sub-session ${sessionLink} first-turn result${stop}:

${body}${parentWarning}`,
        returnDisplay: `${sessionLink} completed${stop}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error creating sub-session: ${message}`,
        returnDisplay: message,
        error: { message }
      };
    }
  }
};
var CreateSubSessionTool = class _CreateSubSessionTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _CreateSubSessionTool.Name,
      ToolDisplayNames.CREATE_SUB_SESSION,
      "Spawn a fresh, independent sub-session (its own clean context and transcript) and run a prompt in it. Use to fan work out into a separate session \u2014 e.g. a self-contained sub-task you want isolated from this conversation.\n\nONLY available when running under `qwen serve` (daemon mode); it is not declared at all in plain interactive or headless sessions.\n\n## Completion modes\n- `first-turn` (default): waits for the sub-session's first turn to finish and returns its result to you. Use when you need the answer back.\n- `sent`: returns immediately after dispatching the prompt, without waiting. Use for fire-and-forget launches whose output you do not need inline.\n\nThe sub-session runs the prompt with full tool access, starting from zero context \u2014 brief it completely in `prompt` (it cannot see this conversation).",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The full, self-contained prompt to run in the new sub-session. It starts with no context from this conversation, so include everything it needs."
          },
          completion: {
            type: "string",
            enum: ["sent", "first-turn"],
            description: "'first-turn' (default) waits for the sub-session's first turn and returns its result. 'sent' returns immediately after the prompt is dispatched (fire-and-forget)."
          },
          model: {
            type: "string",
            description: `Optional model service id for the sub-session. Omit to use the default model. Must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters; the daemon rejects the call otherwise.`
          },
          name: {
            type: "string",
            description: "Optional display name for the sub-session in the session list."
          }
        },
        required: ["prompt"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — spawning is infrequent
      false,
      // alwaysLoad
      "sub-session spawn delegate fan-out isolated session"
    );
    this.config = config;
  }
  static {
    __name(this, "CreateSubSessionTool");
  }
  static Name = ToolNames.CREATE_SUB_SESSION;
  createInvocation(params) {
    return new CreateSubSessionInvocation(this.config, params);
  }
  validateToolParamValues(params) {
    if (!params.prompt || params.prompt.trim() === "") {
      return 'Parameter "prompt" must be a non-empty string.';
    }
    if (params.prompt.length > MAX_SUB_SESSION_PROMPT_CHARS) {
      return `Parameter "prompt" exceeds the ${MAX_SUB_SESSION_PROMPT_CHARS}-character limit.`;
    }
    if (params.completion !== void 0 && params.completion !== "sent" && params.completion !== "first-turn") {
      return 'Parameter "completion" must be "sent" or "first-turn".';
    }
    if (params.model !== void 0 && !isValidCronTaskRoutingId(params.model)) {
      return `Parameter "model" must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters.`;
    }
    return null;
  }
  /**
   * Surface the delegated prompt + mode to the AUTO classifier. The sub-session
   * executes this prompt with tool access, so it must face the same scrutiny as
   * a direct command — without this the classifier sees `create_sub_session({})`
   * and is blind to what the sub-session will be asked to do.
   */
  toAutoClassifierInput(params) {
    return {
      prompt: params.prompt,
      completion: params.completion ?? "first-turn",
      ...params.model ? { model: params.model } : {}
    };
  }
};

export {
  CreateSubSessionTool
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
