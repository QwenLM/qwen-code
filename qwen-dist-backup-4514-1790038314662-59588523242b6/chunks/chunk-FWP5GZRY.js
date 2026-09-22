// Force strict mode and setup for ESM
"use strict";
import {
  createTask
} from "./chunk-PQQV3OBW.js";
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval
} from "./chunk-B5WYAQ4I.js";
import {
  resolveActiveTeamName
} from "./chunk-S6LOFUVP.js";
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

// packages/core/src/tools/task-create.ts
init_esbuild_shims();
var CONFIRMATION_DESCRIPTION_LIMIT = 2e3;
function truncateForConfirmation(text) {
  if (text.length <= CONFIRMATION_DESCRIPTION_LIMIT) return text;
  return `${text.slice(0, CONFIRMATION_DESCRIPTION_LIMIT)}
\u2026 (${text.length - CONFIRMATION_DESCRIPTION_LIMIT} more characters)`;
}
__name(truncateForConfirmation, "truncateForConfirmation");
var TaskCreateInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TaskCreateInvocation");
  }
  getDescription() {
    return `Create task: ${this.params.subject}`;
  }
  /**
   * A task's `description` becomes the prompt an idle teammate auto-claims
   * and executes with full tool access — the same privileged-sink shape as
   * `send_message`, where free-form text turns into a new instruction for
   * another agent. The base default `'allow'` short-circuits the classifier
   * in AUTO mode, so override to `'ask'` to keep that injection path under
   * the classifier / human-in-the-loop.
   */
  async getDefaultPermission() {
    return "ask";
  }
  /**
   * Unlike the one-line getDescription() used for transcript rendering,
   * the confirmation prompt must show the instruction text itself: the
   * `description` is what an idle teammate will auto-claim and execute
   * with full tool access, so it is exactly what the human is approving.
   */
  getConfirmationDetails(_abortSignal) {
    const details = {
      type: "info",
      title: "Confirm TaskCreate",
      prompt: `Create task: ${this.params.subject}

` + truncateForConfirmation(this.params.description),
      onConfirm: /* @__PURE__ */ __name(async () => {
      }, "onConfirm")
    };
    return Promise.resolve(details);
  }
  async execute() {
    if (isPlanRequiredTeammateAwaitingApproval(this.config)) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.TASK_CREATE
      );
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const teamName = resolveActiveTeamName(
      this.config.getTeamContext()?.teamName
    );
    if (!teamName) {
      const msg = "No active team. Create a team first.";
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const task = await createTask(teamName, {
      subject: this.params.subject,
      description: this.params.description,
      activeForm: this.params.activeForm,
      metadata: this.params.metadata
    });
    const llmContent = `Task #${task.id} created: "${task.subject}"`;
    return { llmContent, returnDisplay: llmContent };
  }
};
var TaskCreateTool = class _TaskCreateTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TaskCreateTool.Name,
      ToolDisplayNames.TASK_CREATE,
      "Create a new task in the team task list. Tasks are automatically assigned to idle teammates.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "Short title for the task.",
            maxLength: 200
          },
          description: {
            type: "string",
            description: "Detailed description of the task.",
            maxLength: 1e4
          },
          activeForm: {
            type: "string",
            maxLength: 200,
            description: 'Present tense label for UI (e.g., "Running tests").'
          },
          metadata: {
            type: "object",
            description: "Optional arbitrary metadata."
          }
        },
        required: ["subject", "description"],
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TaskCreateTool");
  }
  static Name = ToolNames.TASK_CREATE;
  createInvocation(params) {
    return new TaskCreateInvocation(this.config, params);
  }
  /**
   * Forward the task content to the classifier. The base sentinel `''`
   * projects to an empty args object, so without this override the AUTO
   * classifier rules on `task_create({})` — the injected payload that
   * `getDefaultPermission() === 'ask'` exists to inspect would be
   * invisible to it. Mirrors `send_message`'s projection.
   */
  toAutoClassifierInput(params) {
    return {
      subject: params.subject,
      description: params.description
    };
  }
};

export {
  truncateForConfirmation,
  TaskCreateTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
