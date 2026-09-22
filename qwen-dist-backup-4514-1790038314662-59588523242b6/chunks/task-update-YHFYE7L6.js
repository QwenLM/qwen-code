// Force strict mode and setup for ESM
"use strict";
import {
  truncateForConfirmation
} from "./chunk-FWP5GZRY.js";
import {
  RECIPROCAL_CALLER,
  TaskOwnershipError,
  TaskSnapshotChangedError,
  assertValidTaskId,
  deleteTask,
  getTask,
  listTasks,
  updateTask
} from "./chunk-PQQV3OBW.js";
import {
  LEADER_NAME,
  sanitizeName
} from "./chunk-YVYK3JYU.js";
import {
  getPlanRequiredTeammatePreApprovalMessage,
  isPlanRequiredTeammateAwaitingApproval,
  isPlanRequiredTeammatePreApprovalAllowedTool
} from "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-5FHOPPLZ.js";
import {
  getAgentName,
  isTeammate,
  resolveActiveTeamName
} from "./chunk-S6LOFUVP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-CA63HYHU.js";
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

// packages/core/src/tools/task-update.ts
init_esbuild_shims();
async function findDependencyCycle(teamName, taskId, addBlocks, addBlockedBy) {
  const tasks = await listTasks(teamName);
  const adjacency = /* @__PURE__ */ new Map();
  const edge = /* @__PURE__ */ __name((from, to) => {
    let set = adjacency.get(from);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      adjacency.set(from, set);
    }
    set.add(to);
  }, "edge");
  for (const task of tasks) {
    for (const id of task.blocks) edge(task.id, id);
    for (const id of task.blockedBy) edge(id, task.id);
  }
  for (const id of addBlocks) edge(taskId, id);
  for (const id of addBlockedBy) edge(id, taskId);
  const path = [];
  const visited = /* @__PURE__ */ new Set();
  const walk = /* @__PURE__ */ __name((node) => {
    path.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (next === taskId) return [...path, taskId];
      if (visited.has(next)) continue;
      visited.add(next);
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    return null;
  }, "walk");
  visited.add(taskId);
  return walk(taskId);
}
__name(findDependencyCycle, "findDependencyCycle");
var TaskUpdateInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "TaskUpdateInvocation");
  }
  getDescription() {
    const parts = [`Task #${this.params.taskId}`];
    if (this.params.status) {
      parts.push(`\u2192 ${this.params.status}`);
    }
    if (this.params.owner) {
      parts.push(`owner: ${this.params.owner}`);
    }
    return parts.join(" ");
  }
  /**
   * Mutating a task's `subject`/`description` rewrites the prompt an idle
   * teammate will auto-claim and execute with full tool access — the same
   * privileged-sink shape as `send_message` and `task_create`. The base
   * default `'allow'` short-circuits the classifier in AUTO mode, so
   * override to `'ask'` to keep that injection path under the classifier /
   * human-in-the-loop.
   */
  async getDefaultPermission() {
    return "ask";
  }
  /**
   * Surface the rewritten instruction text at approval time: an updated
   * `description` is what a claiming teammate will execute, so the
   * dialog must show it — getDescription()'s one-liner only carries
   * status/owner. See task-create.ts for the same rationale.
   */
  getConfirmationDetails(_abortSignal) {
    const lines = [this.getDescription()];
    if (this.params.subject !== void 0) {
      lines.push(`subject: ${this.params.subject}`);
    }
    if (this.params.addBlocks?.length) {
      lines.push(`blocks: ${this.params.addBlocks.join(", ")}`);
    }
    if (this.params.addBlockedBy?.length) {
      lines.push(`blocked by: ${this.params.addBlockedBy.join(", ")}`);
    }
    if (this.params.description !== void 0) {
      lines.push("", truncateForConfirmation(this.params.description));
    }
    const details = {
      type: "info",
      title: "Confirm TaskUpdate",
      prompt: lines.join("\n"),
      onConfirm: /* @__PURE__ */ __name(async () => {
      }, "onConfirm")
    };
    return Promise.resolve(details);
  }
  async execute() {
    const awaitingPlanApproval = isPlanRequiredTeammateAwaitingApproval(
      this.config
    );
    if (awaitingPlanApproval && !isPlanRequiredTeammatePreApprovalAllowedTool(
      ToolNames.TASK_UPDATE,
      this.params
    )) {
      const msg = getPlanRequiredTeammatePreApprovalMessage(
        ToolNames.TASK_UPDATE
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
    const { taskId } = this.params;
    try {
      assertValidTaskId(taskId);
      for (const id of this.params.addBlocks ?? []) {
        assertValidTaskId(id);
      }
      for (const id of this.params.addBlockedBy ?? []) {
        assertValidTaskId(id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (awaitingPlanApproval) {
      const existing2 = await getTask(teamName, taskId);
      if (existing2 && (existing2.status !== "pending" || existing2.owner)) {
        const msg = "task_update can only claim an unowned pending task while this plan-required teammate is waiting for leader approval.";
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
    }
    const teammateCallerName = isTeammate() ? getAgentName() : void 0;
    if (this.params.status === "deleted") {
      let ok;
      try {
        ok = await deleteTask(
          teamName,
          taskId,
          teammateCallerName !== void 0 ? { callerName: teammateCallerName } : void 0
        );
      } catch (err) {
        if (err instanceof TaskOwnershipError) {
          return {
            llmContent: err.message,
            returnDisplay: err.message,
            error: { message: err.message }
          };
        }
        throw err;
      }
      if (!ok) {
        const msg2 = `Task #${taskId} not found.`;
        return {
          llmContent: msg2,
          returnDisplay: msg2,
          error: { message: msg2 }
        };
      }
      const msg = `Task #${taskId} deleted.`;
      return { llmContent: msg, returnDisplay: msg };
    }
    if (this.params.addBlocks?.includes(taskId) || this.params.addBlockedBy?.includes(taskId)) {
      const msg = `Cannot update task #${taskId}: a task cannot block or be blocked by itself.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const referencedIds = /* @__PURE__ */ new Set();
    for (const id of this.params.addBlocks ?? []) {
      if (id !== taskId) referencedIds.add(id);
    }
    for (const id of this.params.addBlockedBy ?? []) {
      if (id !== taskId) referencedIds.add(id);
    }
    if (referencedIds.size > 0) {
      const missing = [];
      await Promise.all(
        Array.from(referencedIds).map(async (id) => {
          const t = await getTask(teamName, id);
          if (!t) missing.push(id);
        })
      );
      if (missing.length > 0) {
        const ids = missing.sort().map((id) => `#${id}`).join(", ");
        const msg = `Cannot update task #${taskId}: referenced task${missing.length === 1 ? "" : "s"} ${ids} not found.`;
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
      const cycle = await findDependencyCycle(
        teamName,
        taskId,
        this.params.addBlocks ?? [],
        this.params.addBlockedBy ?? []
      );
      if (cycle) {
        const msg = `Cannot update task #${taskId}: this would create a dependency cycle (${cycle.map((id) => `#${id}`).join(" \u2192 ")}).`;
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
    }
    const autoOwner = this.params.status === "in_progress" && this.params.owner === void 0 ? getAgentName() : void 0;
    const explicitOwner = this.params.owner === void 0 ? void 0 : sanitizeName(this.params.owner);
    if (this.params.owner !== void 0 && this.params.owner !== "" && !explicitOwner) {
      const msg = `Cannot assign task #${taskId}: owner must include at least one letter, number, or hyphen.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (this.params.status === "in_progress" && !this.params.owner && !autoOwner) {
      const msg = `Cannot move task #${taskId} to in_progress without an owner. Specify the "owner" parameter.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const existing = await getTask(teamName, taskId);
    if (!existing) {
      const msg = `Task #${taskId} not found.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    const teamManager = this.config.getTeamManager?.() ?? null;
    const existingOwner = existing?.owner ? sanitizeName(existing.owner) : void 0;
    const nextOwner = explicitOwner ?? autoOwner ?? existing?.owner;
    const nextStatus = this.params.status ?? existing?.status;
    const statusBecameInProgress = this.params.status === "in_progress" && existing?.status !== "in_progress";
    const ownerChanged = explicitOwner !== void 0 && explicitOwner !== existingOwner;
    const nextBlockedBy = new Set(existing?.blockedBy ?? []);
    for (const blockedBy of this.params.addBlockedBy ?? []) {
      nextBlockedBy.add(blockedBy);
    }
    const shouldDispatchAssignment = nextStatus === "in_progress" && !!nextOwner && nextOwner !== teammateCallerName && (ownerChanged || statusBecameInProgress);
    if (shouldDispatchAssignment && nextBlockedBy.size > 0) {
      const msg = `Cannot assign task #${taskId} to "${nextOwner}" while it is blocked by ${Array.from(nextBlockedBy).map((id) => `#${id}`).join(", ")}. Complete or remove the blocker first.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    if (explicitOwner && teamManager && shouldDispatchAssignment) {
      const refusal = teamManager.validateTaskOwner(explicitOwner);
      if (refusal) {
        return {
          llmContent: refusal,
          returnDisplay: refusal,
          error: { message: refusal }
        };
      }
    }
    let task;
    try {
      const updateOptions = teammateCallerName !== void 0 ? { callerName: teammateCallerName } : explicitOwner !== void 0 || this.params.status !== void 0 ? {
        expectedOwner: existingOwner ?? null,
        expectedStatus: existing.status
      } : void 0;
      task = await updateTask(
        teamName,
        taskId,
        {
          status: this.params.status,
          owner: explicitOwner ?? autoOwner,
          subject: this.params.subject,
          description: this.params.description,
          activeForm: this.params.activeForm,
          metadata: this.params.metadata,
          addBlocks: this.params.addBlocks,
          addBlockedBy: this.params.addBlockedBy
        },
        updateOptions
      );
    } catch (err) {
      if (err instanceof TaskOwnershipError || err instanceof TaskSnapshotChangedError) {
        const dispatchHint = err instanceof TaskSnapshotChangedError && explicitOwner !== void 0 ? " A content-only task_update persists changes without re-delivering the assignment." : "";
        const message = err.message + dispatchHint;
        return {
          llmContent: message,
          returnDisplay: message,
          error: { message }
        };
      }
      throw err;
    }
    if (!task) {
      const msg = `Task #${taskId} not found.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: msg }
      };
    }
    let dispatchFailure;
    const persistedOwner = task.owner ? sanitizeName(task.owner) : void 0;
    if (teamManager && task.status === "in_progress" && persistedOwner && // Leader-owned tasks need no delivery: the leader has no backend
    // agent handle to receive a dispatch prompt, so nothing can be
    // delivered; the exclusion keeps a leader's self-assignment from
    // surfacing a dispatch failure. When a teammate assigns to the
    // leader the update persists with a plain success and the leader
    // sees the task on its next task_list (no notification path).
    persistedOwner !== LEADER_NAME && persistedOwner !== teammateCallerName && (explicitOwner !== void 0 || this.params.status !== void 0) && (persistedOwner !== existingOwner || statusBecameInProgress)) {
      const dispatched = await teamManager.dispatchAssignedTask(task);
      if (!dispatched) {
        const msg = `Task #${taskId} was updated (status: ${task.status}, owner: ${task.owner}), but the assignment prompt could not be delivered. Reassign the task to a different active teammate to retry delivery.`;
        dispatchFailure = {
          llmContent: msg,
          returnDisplay: msg,
          error: { message: msg }
        };
      }
    }
    const reciprocalUpdates = [];
    if (this.params.addBlocks?.length && this.params.status !== "completed") {
      for (const blockedId of this.params.addBlocks) {
        if (blockedId === taskId) continue;
        reciprocalUpdates.push(
          updateTask(
            teamName,
            blockedId,
            { addBlockedBy: [taskId] },
            { callerName: RECIPROCAL_CALLER }
          )
        );
      }
    }
    if (this.params.addBlockedBy?.length) {
      for (const blockerId of this.params.addBlockedBy) {
        if (blockerId === taskId) continue;
        reciprocalUpdates.push(
          updateTask(
            teamName,
            blockerId,
            { addBlocks: [taskId] },
            { callerName: RECIPROCAL_CALLER }
          )
        );
      }
    }
    if (reciprocalUpdates.length > 0) {
      await Promise.all(reciprocalUpdates);
    }
    if (dispatchFailure) return dispatchFailure;
    const llmContent = `Task #${taskId} updated (status: ${task.status}` + (task.owner ? `, owner: ${task.owner}` : "") + ").";
    return { llmContent, returnDisplay: llmContent };
  }
};
var TaskUpdateTool = class _TaskUpdateTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TaskUpdateTool.Name,
      ToolDisplayNames.TASK_UPDATE,
      'Update an existing task. Can change status, owner, subject, description, and blocking relationships. Set status to "deleted" to remove a task. Setting status to "in_progress" auto-assigns you as owner if no owner is set.',
      "other" /* Other */,
      {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "ID of the task to update."
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "deleted"],
            description: "New task status."
          },
          owner: {
            type: "string",
            description: "New owner agent name. Set to empty string to unassign."
          },
          subject: {
            type: "string",
            maxLength: 200,
            description: "Updated task title."
          },
          description: {
            type: "string",
            maxLength: 1e4,
            description: "Updated task description."
          },
          activeForm: {
            type: "string",
            maxLength: 200,
            description: "Present tense label for UI."
          },
          metadata: {
            type: "object",
            description: "Metadata to merge. Set a key to null to delete it."
          },
          addBlocks: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs that this task blocks."
          },
          addBlockedBy: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs that block this task."
          }
        },
        required: ["taskId"],
        additionalProperties: false
      }
    );
    this.config = config;
  }
  static {
    __name(this, "TaskUpdateTool");
  }
  static Name = ToolNames.TASK_UPDATE;
  createInvocation(params) {
    return new TaskUpdateInvocation(this.config, params);
  }
  /**
   * Forward the mutating fields to the classifier. Without this the
   * base `''` sentinel projects to `task_update({})` and the AUTO
   * classifier rules on an empty call — the rewritten instruction
   * text and ownership/edge changes that `'ask'` exists to inspect
   * would be invisible to it. See task-create.ts / send-message.ts.
   */
  toAutoClassifierInput(params) {
    return {
      taskId: params.taskId,
      status: params.status,
      owner: params.owner,
      subject: params.subject,
      description: params.description,
      addBlocks: params.addBlocks,
      addBlockedBy: params.addBlockedBy
    };
  }
};
export {
  TaskUpdateTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
