// Force strict mode and setup for ESM
"use strict";
import {
  promptIdContext
} from "./chunk-O6GEWCJA.js";
import {
  detectTodoChanges,
  escapeSystemReminderTags
} from "./chunk-GXNXX7A2.js";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/todoWrite.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
var debugLogger = createDebugLogger("TODO_WRITE");
var MAX_ACTIVE_TODO_CONTEXT_CHARS = 800;
var todoWriteToolSchemaData = {
  name: "todo_write",
  description: "Creates and manages a concise, user-visible task list for complex or multi-step work.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"]
            },
            id: {
              type: "string",
              maxLength: 500
            },
            blockedBy: {
              type: "array",
              items: { type: "string", maxLength: 500 },
              uniqueItems: true,
              description: "Todo IDs that must be completed before this item. Active-plan updates preserve omitted dependencies for existing IDs; use [] to remove them."
            }
          },
          required: ["content", "status", "id"],
          additionalProperties: false
        },
        description: "The updated todo list"
      }
    },
    required: ["todos"],
    $schema: "http://json-schema.org/draft-07/schema#"
  }
};
var todoWriteToolDescription = `
Use this tool to create and manage a user-visible task list when explicit progress tracking improves clarity.

## When to Use This Tool
Use this tool for work that is complex, ambiguous, or multi-phase; has multiple independent outcomes or important dependencies; benefits from checkpoints; or when the user explicitly asks for a todo list.

Do not use it for simple or single-step work, purely conversational or informational requests, or tasks that can be answered or completed directly unless the user explicitly requests a todo list.

## Planning with Todos

Keep the list short and outcome-oriented. Use a small number of meaningful, logically ordered, verifiable steps. Do not create a separate todo for every error, file, command, or minor edit.

Use blockedBy only when the work has real dependencies. Reference Todo IDs from the same list and keep independent work unblocked.

Keep at most one task in_progress. When a plan exists, keep its statuses current, mark finished work completed, revise the plan when the scope or approach changes, and remove items that are no longer relevant. Do not mark incomplete or blocked work completed.
`;
var TODO_SUBDIR = "todos";
function getTodoFilePath(sessionId) {
  const todoDir = path.join(Storage.getRuntimeBaseDir(), TODO_SUBDIR);
  const filename = `${sessionId || "default"}.json`;
  return path.join(todoDir, filename);
}
__name(getTodoFilePath, "getTodoFilePath");
async function readTodoPlanFromFile(sessionId) {
  try {
    const todoFilePath = getTodoFilePath(sessionId);
    const content = await fs.readFile(todoFilePath, "utf-8");
    const data = JSON.parse(content);
    return {
      ...typeof data["planId"] === "string" ? { planId: data["planId"] } : {},
      todos: Array.isArray(data["todos"]) ? data["todos"] : []
    };
  } catch (err) {
    const error = err;
    if (!(error instanceof Error) || error.code !== "ENOENT") {
      throw err;
    }
    return { todos: [] };
  }
}
__name(readTodoPlanFromFile, "readTodoPlanFromFile");
async function writeTodosToFile(todos, planId, sessionId) {
  const todoFilePath = getTodoFilePath(sessionId);
  const todoDir = path.dirname(todoFilePath);
  await fs.mkdir(todoDir, { recursive: true });
  const data = {
    ...planId ? { planId } : {},
    todos,
    sessionId: sessionId || "default"
  };
  await atomicWriteFile(todoFilePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8"
  });
}
__name(writeTodosToFile, "writeTodosToFile");
var TODO_DEPENDENCY_CYCLE_ERROR = "Todo dependencies must not contain a cycle.";
function validateTodos(value) {
  if (!Array.isArray(value)) {
    return 'Parameter "todos" must be an array.';
  }
  const todos = value;
  for (const todo of todos) {
    if (!todo || typeof todo !== "object") {
      return "Each todo must be an object.";
    }
    if (!todo.id || typeof todo.id !== "string" || todo.id.trim() === "" || todo.id.length > 500) {
      return 'Each todo must have a non-empty "id" string of at most 500 characters.';
    }
    if (!todo.content || typeof todo.content !== "string" || todo.content.trim() === "") {
      return 'Each todo must have a non-empty "content" string.';
    }
    if (!["pending", "in_progress", "completed"].includes(todo.status)) {
      return 'Each todo must have a valid "status" (pending, in_progress, completed).';
    }
    if (todo.blockedBy !== void 0 && (!Array.isArray(todo.blockedBy) || todo.blockedBy.some(
      (dependency) => typeof dependency !== "string" || dependency.trim() === "" || dependency.length > 500
    ))) {
      return 'Each todo "blockedBy" value must be an array of non-empty Todo IDs of at most 500 characters.';
    }
  }
  const ids = todos.map((todo) => todo.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    return "Todo IDs must be unique within the array.";
  }
  for (const todo of todos) {
    const dependencies = todo.blockedBy ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      return `Todo "${todo.id}" must not contain duplicate blockedBy references.`;
    }
    if (dependencies.includes(todo.id)) {
      return `Todo "${todo.id}" must not depend on itself.`;
    }
    const missing = dependencies.find(
      (dependency) => !uniqueIds.has(dependency)
    );
    if (missing) {
      return `Todo "${todo.id}" references unknown dependency "${missing}".`;
    }
  }
  const remainingDependencies = /* @__PURE__ */ new Map();
  const dependents = /* @__PURE__ */ new Map();
  for (const todo of todos) {
    remainingDependencies.set(todo.id, todo.blockedBy?.length ?? 0);
    for (const dependency of todo.blockedBy ?? []) {
      const children = dependents.get(dependency) ?? [];
      children.push(todo.id);
      dependents.set(dependency, children);
    }
  }
  const queue = todos.filter((todo) => remainingDependencies.get(todo.id) === 0).map((todo) => todo.id);
  for (let index = 0; index < queue.length; index++) {
    for (const dependent of dependents.get(queue[index]) ?? []) {
      const remaining = (remainingDependencies.get(dependent) ?? 1) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (queue.length !== todos.length) {
    return TODO_DEPENDENCY_CYCLE_ERROR;
  }
  return null;
}
__name(validateTodos, "validateTodos");
function createBlockedTodoResult(message, systemMessage) {
  return {
    llmContent: `${message}

<system-reminder>
${systemMessage}
</system-reminder>`,
    returnDisplay: message
  };
}
__name(createBlockedTodoResult, "createBlockedTodoResult");
var TodoWriteToolInvocation = class extends BaseToolInvocation {
  constructor(config, params, operationType = "update") {
    super(params);
    this.config = config;
    this.operationType = operationType;
  }
  static {
    __name(this, "TodoWriteToolInvocation");
  }
  operationType;
  refreshActiveTodoReminder(todos, recordWriter = false) {
    const promptId = promptIdContext.getStore();
    if (!promptId) return;
    const unfinishedTodos = todos.filter((todo) => todo.status !== "completed");
    const serializedTodos = escapeSystemReminderTags(
      unfinishedTodos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
    );
    const todoContext = serializedTodos.slice(0, MAX_ACTIVE_TODO_CONTEXT_CHARS);
    this.config.setActiveTodoReminder(
      promptId,
      unfinishedTodos.length > 0 ? `<system-reminder>
The current task still has unfinished todo items:
${todoContext}${serializedTodos.length > todoContext.length ? "\n[truncated]" : ""}
Keep the todo list current and continue the task. Do not treat a successful intermediate tool call as task completion.
</system-reminder>` : void 0
    );
    if (recordWriter && unfinishedTodos.length > 0) {
      this.config.recordActiveTodoPlanWriter?.(promptId);
    }
  }
  getDescription() {
    return this.operationType === "create" ? "Create todos" : "Update todos";
  }
  async execute(_signal) {
    const { todos, modified_by_user, modified_content } = this.params;
    const sessionId = this.config.getSessionId();
    try {
      const previousPlan = await readTodoPlanFromFile(sessionId);
      const oldTodos = previousPlan.todos;
      const oldTodosMap = new Map(oldTodos.map((todo) => [todo.id, todo]));
      const hasActivePlan = oldTodos.some(
        (todo) => todo.status !== "completed"
      );
      let candidateTodos;
      if (modified_by_user && modified_content !== void 0) {
        const data = JSON.parse(modified_content);
        candidateTodos = data["todos"];
      } else {
        let preservedAnyBlockedBy = false;
        candidateTodos = todos.map((todo) => {
          const blockedBy = todo.blockedBy ?? (hasActivePlan ? oldTodosMap.get(todo.id)?.blockedBy?.filter(
            (dependency) => todos.some((incoming) => incoming.id === dependency)
          ) : void 0);
          if (blockedBy === void 0) return todo;
          if (todo.blockedBy === void 0) preservedAnyBlockedBy = true;
          return { ...todo, blockedBy };
        });
        if (preservedAnyBlockedBy) {
          const preservedValidationError = validateTodos(candidateTodos);
          if (preservedValidationError === TODO_DEPENDENCY_CYCLE_ERROR) {
            candidateTodos = todos;
          }
        }
      }
      const validationError = validateTodos(candidateTodos);
      if (validationError) throw new Error(validationError);
      const finalTodos = candidateTodos;
      const boundWorkflowRevision = this.config.getSessionWorkflowPlanRevision?.();
      const approvedWorkflowRevision = boundWorkflowRevision?.approved ? boundWorkflowRevision : void 0;
      const matchesApprovedTodoIds = !approvedWorkflowRevision || finalTodos.length === approvedWorkflowRevision.todoIds.length && finalTodos.every(
        (todo) => approvedWorkflowRevision.todoIds.includes(todo.id)
      );
      if (isDeepStrictEqual(oldTodos, finalTodos)) {
        debugLogger.debug(
          "[TodoWriteTool] No-op: todos unchanged, skipping write/hooks"
        );
        this.refreshActiveTodoReminder(finalTodos);
        const todoResultDisplay2 = {
          type: "todo_list",
          ...previousPlan.planId ? { planId: previousPlan.planId } : {},
          todos: finalTodos,
          changes: { created: [], completed: [] },
          ...this.config.isSessionWorkflowTodoContextActive?.() === true ? { sessionWorkflow: true } : {},
          unchanged: true
        };
        return {
          llmContent: `Todo list is already up to date. No changes were needed.

<system-reminder>
Your todo list was not modified because it is already current. Continue with your existing tasks.
</system-reminder>`,
          returnDisplay: todoResultDisplay2
        };
      }
      const changes = detectTodoChanges(oldTodos, finalTodos);
      const hookSystem = this.config.getHookSystem();
      if (hookSystem && changes.created.length > 0) {
        const createdResults = await Promise.all(
          changes.created.map(
            (todo) => hookSystem.fireTodoCreatedEvent(
              todo.id,
              todo.content,
              todo.status,
              finalTodos,
              "validation" /* Validation */,
              _signal
            )
          )
        );
        const blockedCreatedResult = createdResults.find(
          (result) => result.finalOutput?.decision === "block"
        );
        if (blockedCreatedResult?.finalOutput) {
          const reason = blockedCreatedResult.finalOutput.reason || "Hook blocked todo creation";
          return createBlockedTodoResult(
            `Todo creation blocked: ${reason}`,
            `Todo list was not modified because a TodoCreated hook blocked the operation: ${reason}`
          );
        }
      }
      if (hookSystem && changes.completed.length > 0) {
        const completedResults = await Promise.all(
          changes.completed.map((todo) => {
            const oldTodo = oldTodosMap.get(todo.id);
            const previousStatus = oldTodo?.status ?? "pending";
            return hookSystem.fireTodoCompletedEvent(
              todo.id,
              todo.content,
              previousStatus,
              finalTodos,
              "validation" /* Validation */,
              _signal
            );
          })
        );
        const blockedCompletedResult = completedResults.find(
          (result) => result.finalOutput?.decision === "block"
        );
        if (blockedCompletedResult?.finalOutput) {
          const reason = blockedCompletedResult.finalOutput.reason || "Hook blocked todo completion";
          return createBlockedTodoResult(
            `Todo completion blocked: ${reason}`,
            `Todo list was not modified because a TodoCompleted hook blocked the operation: ${reason}`
          );
        }
      }
      const startsNewPlan = finalTodos.length > 0 && (oldTodos.length === 0 || oldTodos.every((todo) => todo.status === "completed") && !isDeepStrictEqual(finalTodos, oldTodos) || previousPlan.planId === approvedWorkflowRevision?.planId && !matchesApprovedTodoIds);
      const activePlanId = finalTodos.length === 0 ? void 0 : startsNewPlan || !previousPlan.planId ? randomUUID() : previousPlan.planId;
      const resultPlanId = activePlanId ?? previousPlan.planId;
      await writeTodosToFile(finalTodos, activePlanId, sessionId);
      const continuesApprovedWorkflow = !approvedWorkflowRevision || resultPlanId === approvedWorkflowRevision.planId && matchesApprovedTodoIds;
      if (!continuesApprovedWorkflow) {
        this.config.clearSessionWorkflowPlanRevision?.();
      }
      this.refreshActiveTodoReminder(finalTodos, true);
      let postWriteError;
      try {
        if (hookSystem && changes.created.length > 0) {
          for (const todo of changes.created) {
            await hookSystem.fireTodoCreatedEvent(
              todo.id,
              todo.content,
              todo.status,
              finalTodos,
              "postWrite" /* PostWrite */,
              _signal
            );
          }
        }
        if (hookSystem && changes.completed.length > 0) {
          for (const todo of changes.completed) {
            const oldTodo = oldTodosMap.get(todo.id);
            const previousStatus = oldTodo?.status ?? "pending";
            await hookSystem.fireTodoCompletedEvent(
              todo.id,
              todo.content,
              previousStatus,
              finalTodos,
              "postWrite" /* PostWrite */,
              _signal
            );
          }
        }
      } catch (error) {
        postWriteError = error instanceof Error ? error : new Error(String(error));
        debugLogger.error(
          `[TodoWriteTool] Post-write hooks failed after todos were persisted: ${postWriteError.message}`
        );
      }
      const workflowContextActive = continuesApprovedWorkflow && this.config.isSessionWorkflowTodoContextActive?.() === true;
      const todoResultDisplay = {
        type: "todo_list",
        ...resultPlanId ? { planId: resultPlanId } : {},
        ...workflowContextActive ? { sessionWorkflow: true } : {},
        todos: finalTodos,
        changes
      };
      const todosJson = JSON.stringify(finalTodos);
      let llmContent;
      const postWriteReminder = postWriteError ? `

<system-reminder>
Todos were persisted successfully, but post-write hooks failed with error: ${postWriteError.message}. Do not tell the user the write failed; only handle any follow-up hook issues if needed.
</system-reminder>` : "";
      if (finalTodos.length === 0) {
        llmContent = `Todo list has been cleared.

<system-reminder>
Your todo list is now empty. DO NOT mention this explicitly to the user. You have no pending tasks in your todo list.
</system-reminder>${postWriteReminder}`;
      } else {
        llmContent = `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable

<system-reminder>
Your todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list:

${todosJson}. Continue on with the tasks at hand if applicable.
</system-reminder>${postWriteReminder}`;
      }
      return {
        llmContent,
        returnDisplay: todoResultDisplay
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[TodoWriteTool] Error executing todo_write: ${errorMessage}`
      );
      const errorLlmContent = `Failed to modify todos. An error occurred during the operation.

<system-reminder>
Todo list modification failed with error: ${errorMessage}. You may need to retry or handle this error appropriately.
</system-reminder>`;
      return {
        llmContent: errorLlmContent,
        returnDisplay: `Error writing todos: ${errorMessage}`
      };
    }
  }
};
async function readTodosForSession(sessionId) {
  return (await readTodoPlanFromFile(sessionId)).todos;
}
__name(readTodosForSession, "readTodosForSession");
async function listTodoSessions() {
  try {
    const todoDir = path.join(Storage.getRuntimeBaseDir(), TODO_SUBDIR);
    const files = await fs.readdir(todoDir);
    return files.filter((file) => file.endsWith(".json")).map((file) => file.replace(".json", ""));
  } catch (err) {
    const error = err;
    if (!(error instanceof Error) || error.code !== "ENOENT") {
      throw err;
    }
    return [];
  }
}
__name(listTodoSessions, "listTodoSessions");
var TodoWriteTool = class _TodoWriteTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _TodoWriteTool.Name,
      ToolDisplayNames.TODO_WRITE,
      todoWriteToolDescription,
      "think" /* Think */,
      todoWriteToolSchemaData.parametersJsonSchema
    );
    this.config = config;
  }
  static {
    __name(this, "TodoWriteTool");
  }
  static Name = ToolNames.TODO_WRITE;
  validateToolParams(params) {
    return validateTodos(params.todos);
  }
  createInvocation(params) {
    const sessionId = this.config.getSessionId();
    const todoFilePath = getTodoFilePath(sessionId);
    const operationType = fsSync.existsSync(todoFilePath) ? "update" : "create";
    return new TodoWriteToolInvocation(this.config, params, operationType);
  }
};
export {
  TodoWriteTool,
  listTodoSessions,
  readTodosForSession
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
