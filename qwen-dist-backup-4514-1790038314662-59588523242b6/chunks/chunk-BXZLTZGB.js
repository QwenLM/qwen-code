// Force strict mode and setup for ESM
"use strict";
import {
  buildScheduledTaskRunPrompt,
  parseChannelDelivery,
  scheduledTaskRunSessionName,
  scheduledTaskRunSourceId
} from "./chunk-HK5DBR6P.js";
import {
  createSessionOrganizationService
} from "./chunk-UH6N3LO7.js";
import {
  parseCallerSuppliedSessionId
} from "./chunk-ZEZKIS2K.js";
import {
  isInternalWorkspaceRuntime
} from "./chunk-NYWWQ437.js";
import {
  SCHEDULED_TASK_RUN_SOURCE_TYPE
} from "./chunk-7RZUXNH6.js";
import {
  SessionNotFoundError
} from "./chunk-YXHY6BKS.js";
import {
  canonicalizeWorkspace
} from "./chunk-6PLDPT2C.js";
import {
  isChannelDeliveryError
} from "./chunk-RKFGE7JH.js";
import {
  isWithinRoot
} from "./chunk-MR3PXB6E.js";
import {
  SessionService
} from "./chunk-MRTRBONQ.js";
import {
  MAX_JOBS,
  nextDurableFireMs
} from "./chunk-4SZ2636R.js";
import {
  nextFireTime,
  parseCron
} from "./chunk-5EZRLTLQ.js";
import {
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  annotateCronRunSession,
  appendCronRun,
  cronTaskSessionDeletionId,
  generateCronTaskId,
  getCronFilePath,
  isValidCronTaskRoutingId,
  readCronTasks,
  taskHasLegacyCondition,
  updateCronTasks
} from "./chunk-C4FISGDN.js";
import {
  stripTerminalControlSequences
} from "./chunk-IMV5DBIP.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/routes/scheduled-tasks.ts
init_esbuild_shims();
import { isDeepStrictEqual } from "node:util";
import { access } from "node:fs/promises";

// packages/cli/src/serve/workspace-route-runtime.ts
init_esbuild_shims();
import * as fs from "node:fs";
import path from "node:path";
function resolveWorkspaceEntryFromParam(registry, req, res, paramName = "workspace") {
  const selector = req.params[paramName] ?? "";
  const byId = registry.getEntryByWorkspaceId(selector);
  if (byId) return byId;
  if (!isPortableAbsolutePath(selector)) {
    res.status(400).json({
      error: `\`:${paramName}\` must decode to a workspace id or absolute path`,
      code: "workspace_mismatch"
    });
    return null;
  }
  const exact = registry.getEntryByWorkspaceCwd(selector);
  if (exact) return exact;
  if (path.isAbsolute(selector) && !isUncPath(selector)) {
    try {
      const canonicalSelector = canonicalizeWorkspace(selector);
      const canonicalMatch = registry.getEntryByWorkspaceCwd(canonicalSelector);
      if (canonicalMatch) return canonicalMatch;
      for (const candidate of registry.listEntries()) {
        if (canonicalizeWorkspace(candidate.workspaceCwd) === canonicalSelector) {
          return candidate;
        }
      }
    } catch {
    }
  }
  const normalizedSelector = normalizePortableAbsolutePath(selector);
  const entry = registry.listEntries().find(
    (candidate) => normalizePortableAbsolutePath(candidate.workspaceCwd) === normalizedSelector
  );
  if (!entry) {
    sendWorkspaceMismatch(res, registry);
    return null;
  }
  return entry;
}
__name(resolveWorkspaceEntryFromParam, "resolveWorkspaceEntryFromParam");
function isPortableAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
__name(isPortableAbsolutePath, "isPortableAbsolutePath");
function isUncPath(value) {
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}
__name(isUncPath, "isUncPath");
function normalizePortableAbsolutePath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return path.win32.normalize(value).toLowerCase();
  }
  return path.resolve(value);
}
__name(normalizePortableAbsolutePath, "normalizePortableAbsolutePath");
function resolveRegisteredWorkspaceRuntimeByPathSelector(registry, selector) {
  const exact = registry.getByWorkspaceCwd(selector);
  if (exact) return exact;
  if (path.isAbsolute(selector) && !isUncPath(selector)) {
    try {
      const canonicalSelector = canonicalizeWorkspace(selector);
      const canonicalMatch = registry.getByWorkspaceCwd(canonicalSelector);
      if (canonicalMatch) return canonicalMatch;
      for (const runtime of registry.list()) {
        if (canonicalizeWorkspace(runtime.workspaceCwd) === canonicalSelector) {
          return runtime;
        }
      }
    } catch {
    }
  }
  const normalizedSelector = normalizePortableAbsolutePath(selector);
  return registry.list().find(
    (runtime) => normalizePortableAbsolutePath(runtime.workspaceCwd) === normalizedSelector
  );
}
__name(resolveRegisteredWorkspaceRuntimeByPathSelector, "resolveRegisteredWorkspaceRuntimeByPathSelector");
function resolveManagedWorkspaceRuntimeByPathSelector(registry, selector) {
  const exact = registry.getManagedByWorkspaceCwd(selector);
  if (exact && !isInternalWorkspaceRuntime(exact)) return exact;
  if (path.isAbsolute(selector) && !isUncPath(selector)) {
    try {
      const canonicalSelector = canonicalizeWorkspace(selector);
      const canonicalMatch = registry.getManagedByWorkspaceCwd(canonicalSelector);
      if (canonicalMatch && !isInternalWorkspaceRuntime(canonicalMatch)) {
        return canonicalMatch;
      }
      for (const runtime of registry.listManaged()) {
        if (isInternalWorkspaceRuntime(runtime)) continue;
        if (canonicalizeWorkspace(runtime.workspaceCwd) === canonicalSelector) {
          return runtime;
        }
      }
    } catch {
    }
  }
  const normalizedSelector = normalizePortableAbsolutePath(selector);
  return registry.listManaged().find(
    (runtime) => !isInternalWorkspaceRuntime(runtime) && normalizePortableAbsolutePath(runtime.workspaceCwd) === normalizedSelector
  );
}
__name(resolveManagedWorkspaceRuntimeByPathSelector, "resolveManagedWorkspaceRuntimeByPathSelector");
function resolveWorkspaceRuntimeFromParam(registry, req, res, paramName = "workspace") {
  const entry = resolveWorkspaceEntryFromParam(registry, req, res, paramName);
  if (!entry) return null;
  const runtime = entry.state === "active" ? entry.current?.runtime : void 0;
  if (!runtime) {
    sendWorkspaceRuntimeUnavailable(res, entry);
    return null;
  }
  return runtime;
}
__name(resolveWorkspaceRuntimeFromParam, "resolveWorkspaceRuntimeFromParam");
function resolveTrustedRuntime(registry, req, res, paramName = "workspace") {
  const runtime = resolveWorkspaceRuntimeFromParam(
    registry,
    req,
    res,
    paramName
  );
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}
__name(resolveTrustedRuntime, "resolveTrustedRuntime");
function resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(registry, req, res, paramName = "workspace") {
  if (typeof registry.getManagedEntryByWorkspaceId !== "function" || typeof registry.getManagedEntryByWorkspaceCwd !== "function") {
    return resolveWorkspaceRuntimeFromParam(registry, req, res, paramName);
  }
  const selector = req.params[paramName] ?? "";
  let entry = registry.getManagedEntryByWorkspaceId(selector);
  if (!entry && isPortableAbsolutePath(selector)) {
    entry = registry.getManagedEntryByWorkspaceCwd(selector);
  }
  if (!entry?.internal) {
    return resolveWorkspaceRuntimeFromParam(registry, req, res, paramName);
  }
  const runtime = entry.state === "active" ? entry.current?.runtime : void 0;
  if (!runtime) {
    sendConversationRuntimeUnavailable(res);
    return null;
  }
  return runtime;
}
__name(resolveWorkspaceRuntimeWithLiveCompatibilityFromParam, "resolveWorkspaceRuntimeWithLiveCompatibilityFromParam");
function sendConversationRuntimeUnavailable(res) {
  res.set("Retry-After", "1");
  res.status(503).json({
    error: "The Conversations runtime is temporarily unavailable.",
    code: "conversation_runtime_unavailable",
    retryable: true
  });
}
__name(sendConversationRuntimeUnavailable, "sendConversationRuntimeUnavailable");
function sendWorkspaceRuntimeUnavailable(res, entry) {
  res.set("Retry-After", "1");
  res.status(503).json({
    error: "Workspace runtime is not active.",
    code: "workspace_runtime_unavailable",
    ...entry ? { workspaceCwd: entry.workspaceCwd, workspaceId: entry.workspaceId } : {}
  });
}
__name(sendWorkspaceRuntimeUnavailable, "sendWorkspaceRuntimeUnavailable");
function isGenerationClosedError(error) {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "workspace_generation_closed"
  );
}
__name(isGenerationClosedError, "isGenerationClosedError");
function sendGenerationClosedError(res, error) {
  if (!isGenerationClosedError(error)) return false;
  sendWorkspaceRuntimeUnavailable(res);
  return true;
}
__name(sendGenerationClosedError, "sendGenerationClosedError");
function resolveManagedWorkspaceRuntimeFromParam(registry, req, res, paramName = "workspace") {
  const selector = req.params[paramName] ?? "";
  const byId = registry.getManagedByWorkspaceId(selector);
  if (byId && !isInternalWorkspaceRuntime(byId)) return byId;
  if (!isPortableAbsolutePath(selector)) {
    res.status(400).json({
      error: `\`:${paramName}\` must decode to a workspace id or absolute path`,
      code: "workspace_mismatch"
    });
    return null;
  }
  const runtime = resolveManagedWorkspaceRuntimeByPathSelector(
    registry,
    selector
  );
  if (!runtime) {
    res.status(400).json({
      error: "Workspace mismatch: the requested workspace is not registered with this daemon.",
      code: "workspace_mismatch"
    });
    return null;
  }
  return runtime;
}
__name(resolveManagedWorkspaceRuntimeFromParam, "resolveManagedWorkspaceRuntimeFromParam");
function requireTrustedWorkspaceRuntime(runtime, res) {
  if (runtime.trusted) return true;
  sendUntrustedWorkspaceResponse(res);
  return false;
}
__name(requireTrustedWorkspaceRuntime, "requireTrustedWorkspaceRuntime");
function sendUntrustedWorkspaceResponse(res, extra) {
  res.status(403).json({
    error: "Workspace is not trusted.",
    code: "untrusted_workspace",
    ...extra
  });
}
__name(sendUntrustedWorkspaceResponse, "sendUntrustedWorkspaceResponse");
function getWorkspaceRouteContext(req) {
  return req.workspaceRouteContext;
}
__name(getWorkspaceRouteContext, "getWorkspaceRouteContext");
function setWorkspaceRouteContext(req, context) {
  req.workspaceRouteContext = context;
}
__name(setWorkspaceRouteContext, "setWorkspaceRouteContext");
function sendWorkspaceMismatch(res, registry) {
  res.status(400).json({
    error: "Workspace mismatch: the requested workspace is not registered with this daemon.",
    code: "workspace_mismatch",
    workspaceCount: registry.listEntries().length
  });
}
__name(sendWorkspaceMismatch, "sendWorkspaceMismatch");
function resolveContainedCwd(req, workspaceCwd) {
  const rawCwd = req.query["cwd"];
  if (typeof rawCwd !== "string" || rawCwd.length === 0) {
    return workspaceCwd;
  }
  try {
    const resolved = fs.realpathSync(path.resolve(rawCwd));
    const root = fs.realpathSync(workspaceCwd);
    if (isWithinRoot(resolved, root)) {
      return resolved;
    }
  } catch {
  }
  return workspaceCwd;
}
__name(resolveContainedCwd, "resolveContainedCwd");
function resolveContainedCwdOrFail(req, workspaceCwd) {
  const rawCwd = req.query["cwd"];
  if (rawCwd === void 0) {
    return workspaceCwd;
  }
  if (typeof rawCwd !== "string" || rawCwd.length === 0) {
    return null;
  }
  try {
    const resolved = fs.realpathSync(path.resolve(rawCwd));
    const root = fs.realpathSync(workspaceCwd);
    if (isWithinRoot(resolved, root)) {
      return resolved;
    }
  } catch {
  }
  return null;
}
__name(resolveContainedCwdOrFail, "resolveContainedCwdOrFail");

// packages/cli/src/serve/routes/scheduled-tasks.ts
var MAX_SCHEDULED_TASKS = MAX_JOBS;
var MAX_PROMPT_LENGTH = 1e5;
var MAX_NAME_LENGTH = 200;
var MAX_CRON_LENGTH = 200;
var MAX_ROUTING_ID_LENGTH = MAX_CRON_TASK_ROUTING_ID_LENGTH;
var MAX_SESSION_NAME_LENGTH = 60;
function scheduledTaskSessionName(label) {
  const cleaned = stripTerminalControlSequences(label).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/\s+/g, " ");
  let short = cleaned;
  if (cleaned.length > MAX_SESSION_NAME_LENGTH) {
    let cut = MAX_SESSION_NAME_LENGTH - 1;
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 55296 && boundary <= 56319) cut -= 1;
    short = `${cleaned.slice(0, cut)}\u2026`;
  }
  return short;
}
__name(scheduledTaskSessionName, "scheduledTaskSessionName");
var ExistingSessionScheduledTaskCreateError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ExistingSessionScheduledTaskCreateError";
  }
  static {
    __name(this, "ExistingSessionScheduledTaskCreateError");
  }
};
function assertReusableScheduledTaskSession(target, sessionId, allowActivePrompt, assertCallerPromptActive) {
  const { bridge, workspaceCwd } = target;
  if (!bridge) {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      "session_binding_unavailable",
      "Session management is not available for this workspace"
    );
  }
  assertCallerPromptActive?.();
  let owner;
  try {
    owner = target.resolveLiveSessionOwner?.(sessionId);
  } catch (error) {
    writeStderrLine(
      `qwen serve: failed to resolve scheduled-task session owner '${sessionId}': ${error instanceof Error ? error.message : String(error)}`
    );
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      "scheduled_tasks_session_failed",
      "Failed to look up the requested session"
    );
  }
  if (owner?.kind === "unavailable") {
    throw new ExistingSessionScheduledTaskCreateError(
      503,
      "workspace_runtime_unavailable",
      "The workspace runtime is unavailable"
    );
  }
  if (owner?.kind === "ambiguous") {
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      "ambiguous_session_owner",
      `Session owner is ambiguous for "${sessionId}"`
    );
  }
  if (owner?.kind === "found" && owner.runtime.workspaceCwd !== workspaceCwd) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      "session_workspace_mismatch",
      "The requested session belongs to a different workspace; use that workspace's scheduled-task endpoint"
    );
  }
  let summary;
  try {
    summary = bridge.getSessionSummary(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new ExistingSessionScheduledTaskCreateError(
        404,
        "session_not_found",
        `Session '${sessionId}' was not found`
      );
    }
    writeStderrLine(
      `qwen serve: failed to look up scheduled-task session '${sessionId}': ${error instanceof Error ? error.message : String(error)}`
    );
    throw new ExistingSessionScheduledTaskCreateError(
      500,
      "scheduled_tasks_session_failed",
      "Failed to look up the requested session"
    );
  }
  if (summary.workspaceCwd !== workspaceCwd) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      "session_workspace_mismatch",
      "The requested session belongs to a different workspace; use that workspace's scheduled-task endpoint"
    );
  }
  if (!allowActivePrompt && summary.hasActivePrompt || (summary.pendingInteractionCount ?? 0) > 0) {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      "session_busy",
      allowActivePrompt ? "The caller session has a pending interaction; resolve it before binding the session to a task" : "The requested session is busy; wait for its active prompt or pending interaction to finish before binding it to a task"
    );
  }
  if (summary.sourceType === "scheduled_task") {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      "session_already_bound",
      "The requested session is already reserved for a scheduled task"
    );
  }
  if (summary.parentSessionId !== void 0 || summary.sourceId !== void 0 || summary.sourceType !== void 0 && summary.sourceType !== "default") {
    throw new ExistingSessionScheduledTaskCreateError(
      409,
      "session_source_ineligible",
      "The requested session source cannot own a scheduled task"
    );
  }
}
__name(assertReusableScheduledTaskSession, "assertReusableScheduledTaskSession");
async function createScheduledTaskWithExistingSession(target, input, options) {
  if (input.cron.length === 0 || input.cron.length > MAX_CRON_LENGTH || validateCron(input.cron) !== null) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      "invalid_cron",
      "The scheduled-task cron expression is invalid"
    );
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ExistingSessionScheduledTaskCreateError(
      400,
      "invalid_prompt",
      "The scheduled-task prompt is invalid"
    );
  }
  const allowActivePrompt = options.source === "cron-tool";
  const assertCallerPromptActive = options.source === "cron-tool" ? options.assertCallerPromptActive : void 0;
  assertReusableScheduledTaskSession(
    target,
    input.sessionId,
    allowActivePrompt,
    assertCallerPromptActive
  );
  target.assertGenerationOpen?.();
  if (options.source === "rest") {
    const ensurePersisted = target.bridge?.ensureDefaultSessionPersisted;
    if (!ensurePersisted) {
      throw new ExistingSessionScheduledTaskCreateError(
        409,
        "session_binding_unavailable",
        "Session persistence is not available for this workspace"
      );
    }
    try {
      await ensurePersisted.call(target.bridge, input.sessionId);
    } catch (error) {
      target.assertGenerationOpen?.();
      if (error instanceof SessionNotFoundError) {
        throw new ExistingSessionScheduledTaskCreateError(
          404,
          "session_not_found",
          `Session '${input.sessionId}' was not found`
        );
      }
      writeStderrLine(
        `qwen serve: failed to persist scheduled-task session '${input.sessionId}': ${error instanceof Error ? error.message : String(error)}`
      );
      throw new ExistingSessionScheduledTaskCreateError(
        500,
        "session_persistence_failed",
        "Failed to persist the requested session"
      );
    }
    target.assertGenerationOpen?.();
  }
  const now = Date.now();
  const task = {
    id: generateCronTaskId(),
    cron: input.cron,
    prompt,
    recurring: input.recurring,
    createdAt: now,
    lastFiredAt: now - now % 6e4,
    enabled: input.enabled !== false,
    sessionId: input.sessionId,
    sessionOwnedByTask: false,
    sessionMode: input.sessionMode === "per_run" ? "per_run" : "persistent",
    ...input.sessionMode === "per_run" && input.modelServiceId !== void 0 ? { modelServiceId: input.modelServiceId } : {},
    ...input.sessionMode === "per_run" && input.groupId !== void 0 ? { groupId: input.groupId } : {},
    ...input.delivery !== void 0 ? { delivery: input.delivery } : {},
    ...input.name !== void 0 ? { name: input.name } : {}
  };
  let before;
  let after;
  await runWithScheduledTaskTarget(
    target,
    () => updateCronTasks(
      target.workspaceCwd,
      (tasks) => {
        assertReusableScheduledTaskSession(
          target,
          input.sessionId,
          allowActivePrompt,
          assertCallerPromptActive
        );
        if (tasks.some((candidate) => candidate.sessionId === input.sessionId)) {
          throw new ExistingSessionScheduledTaskCreateError(
            409,
            "session_already_bound",
            "The requested session is already bound to another scheduled task"
          );
        }
        if (tasks.length >= MAX_SCHEDULED_TASKS) {
          throw new ExistingSessionScheduledTaskCreateError(
            409,
            "max_tasks_reached",
            `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`
          );
        }
        before = tasks;
        after = [...tasks, task];
        return after;
      },
      { assertCanCommit: target.assertGenerationOpen }
    )
  );
  try {
    target.assertGenerationOpen?.();
  } catch (error) {
    await rollbackCronMutation(target, before, after, "scheduled-task create");
    throw error;
  }
  return task;
}
__name(createScheduledTaskWithExistingSession, "createScheduledTaskWithExistingSession");
function requireOpenGeneration(target, res) {
  try {
    target.assertGenerationOpen?.();
    return true;
  } catch (error) {
    if (sendGenerationClosedError(res, error)) return false;
    throw error;
  }
}
__name(requireOpenGeneration, "requireOpenGeneration");
async function rollbackCronMutation(target, before, after, route) {
  if (!before || !after) return;
  await runWithScheduledTaskTarget(
    target,
    () => updateCronTasks(
      target.workspaceCwd,
      (tasks) => isDeepStrictEqual(tasks, after) ? before : tasks
    )
  ).catch((error) => {
    writeStderrLine(
      `qwen serve: ${route} failed to roll back a stale task mutation: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}
__name(rollbackCronMutation, "rollbackCronMutation");
async function restoreConsumedOneShot(target, before, failedTask, removalGenerations, route) {
  const id = failedTask.id;
  const index = before?.findIndex((t) => t.id === id) ?? -1;
  const original = index === -1 ? void 0 : before[index];
  if (!original || !removalGenerations) return;
  let restoreGenerations;
  await runWithScheduledTaskTarget(
    target,
    () => updateCronTasks(
      target.workspaceCwd,
      (tasks) => {
        if ([...removalGenerations].some(
          ([key, generation]) => restoreGenerations?.get(key) !== generation
        ))
          return tasks;
        if (tasks.some((t) => t.id === id)) return tasks;
        const restored = [...tasks];
        restored.splice(Math.min(index, restored.length), 0, {
          ...failedTask,
          enabled: false
        });
        return restored;
      },
      {
        observeDeletionIds: [...removalGenerations.keys()],
        onDeletionGenerations: /* @__PURE__ */ __name((generations) => {
          restoreGenerations = generations;
        }, "onDeletionGenerations")
      }
    )
  ).catch((error) => {
    writeStderrLine(
      `qwen serve: ${route} failed to restore the consumed one-shot task: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}
__name(restoreConsumedOneShot, "restoreConsumedOneShot");
async function teardownBoundSession(target, sessionId) {
  if (target.cleanupSession) {
    await target.cleanupSession(sessionId).catch(() => {
    });
  } else if (target.bridge) {
    await target.bridge.closeSession(sessionId).catch(() => {
    });
    const removed = await new SessionService(target.workspaceCwd, {
      runtimeBaseDir: target.runtimeBaseDir
    }).removeSession(sessionId).catch(() => false);
    if (removed) target.bridge.markSessionCatalogChanged?.();
  }
}
__name(teardownBoundSession, "teardownBoundSession");
async function dispatchTaskToFreshSession(target, task) {
  const { bridge } = target;
  const sendPrompt = bridge?.sendPrompt?.bind(bridge);
  if (!bridge || !sendPrompt || !task.sessionId) {
    throw new Error("Fresh-session dispatch is unavailable for this task");
  }
  const triggeredAt = task.lastFiredAt ?? Date.now();
  const child = await runWithScheduledTaskTarget(
    target,
    () => bridge.spawnOrAttach({
      workspaceCwd: target.workspaceCwd,
      ...task.modelServiceId ? { modelServiceId: task.modelServiceId } : {},
      sessionScope: "thread",
      parentSessionId: task.sessionId,
      sourceType: SCHEDULED_TASK_RUN_SOURCE_TYPE,
      sourceId: scheduledTaskRunSourceId(task.id)
    })
  );
  try {
    if (task.modelServiceId && child.modelApplied === false) {
      throw new Error(
        `Scheduled task model selection failed: ${task.modelServiceId}`
      );
    }
    try {
      bridge.updateSessionMetadata(child.sessionId, {
        displayName: scheduledTaskRunSessionName(
          task.name ?? task.prompt,
          triggeredAt
        ),
        titleSource: "auto"
      });
    } catch {
    }
    let markPromptAdmitted;
    const promptAdmitted = new Promise((resolve) => {
      markPromptAdmitted = resolve;
    });
    const turn = sendPrompt(
      child.sessionId,
      {
        sessionId: child.sessionId,
        prompt: [
          {
            type: "text",
            text: buildScheduledTaskRunPrompt({
              id: task.id,
              name: task.name,
              cron: task.cron,
              prompt: task.prompt,
              triggeredAt,
              trigger: "manual"
            })
          }
        ]
      },
      void 0,
      {
        onPromptAdmitted: markPromptAdmitted
      }
    );
    void turn.catch((error) => {
      writeStderrLine(
        `qwen serve: scheduled-task session ${child.sessionId} prompt failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    await Promise.race([
      promptAdmitted,
      turn.then(
        () => void 0,
        (error) => Promise.reject(error)
      )
    ]);
    if (task.groupId) {
      try {
        await runWithScheduledTaskTarget(
          target,
          () => createSessionOrganizationService(
            target.workspaceCwd
          ).updateSessionOrganization(child.sessionId, {
            groupId: task.groupId,
            color: null
          })
        );
        bridge.markSessionCatalogChanged?.();
      } catch (error) {
        writeStderrLine(
          `qwen serve: scheduled-task session ${child.sessionId} could not be assigned to group ${task.groupId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    await teardownBoundSession(target, child.sessionId);
    throw error;
  }
  return child.sessionId;
}
__name(dispatchTaskToFreshSession, "dispatchTaskToFreshSession");
async function runWithScheduledTaskTarget(target, fn) {
  const result = target.runtimeBaseDir === void 0 ? fn() : Storage.runWithResolvedRuntimeBaseDir(target.runtimeBaseDir, fn);
  return await result;
}
__name(runWithScheduledTaskTarget, "runWithScheduledTaskTarget");
function sendActivityGateError(res, error) {
  if (!error || typeof error !== "object" || error.code !== "daemon_draining") {
    return false;
  }
  res.status(503).json({
    error: "The daemon is draining and no longer accepts work.",
    code: "daemon_draining"
  });
  return true;
}
__name(sendActivityGateError, "sendActivityGateError");
function computeNextRunAt(task) {
  if (task.enabled === false) return null;
  return nextDurableFireMs(task);
}
__name(computeNextRunAt, "computeNextRunAt");
function toView(task) {
  return {
    id: task.id,
    name: typeof task.name === "string" && task.name.length > 0 ? task.name : null,
    cron: task.cron,
    prompt: task.prompt,
    recurring: task.recurring,
    // Absent enabled defaults to enabled — tool-created tasks never write it.
    // A legacy guarded task (isolated run mode + precondition, both removed) is
    // reported as NOT runnable — `enabled: false` with no `nextRunAt` — so the
    // management UI never shows it as active or offers a Run affordance for a
    // task the scheduler refuses to fire. Fail closed on the read path too, not
    // just the tick. `POST /:id/run` rejects it as a second guard.
    enabled: task.enabled !== false && !taskHasLegacyCondition(task),
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
    nextRunAt: taskHasLegacyCondition(task) ? null : computeNextRunAt(task),
    // The task's bound session (its run-history transcript), or null for an
    // unbound tool-created/legacy task.
    sessionId: typeof task.sessionId === "string" && task.sessionId.length > 0 ? task.sessionId : null,
    sessionMode: task.sessionMode === "per_run" ? "per_run" : "persistent",
    modelServiceId: task.modelServiceId ?? null,
    groupId: task.groupId ?? null,
    // Absent runs (tool-created / never-fired) normalizes to [] so the client
    // never special-cases undefined.
    runs: Array.isArray(task.runs) ? task.runs : [],
    ...task.delivery !== void 0 ? { delivery: task.delivery } : {}
  };
}
__name(toView, "toView");
function validateCron(cron) {
  try {
    parseCron(cron);
    nextFireTime(cron, /* @__PURE__ */ new Date());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
__name(validateCron, "validateCron");
function canonicalCron(cron) {
  try {
    const f = parseCron(cron);
    const s = /* @__PURE__ */ __name((set) => [...set].sort((a, b) => a - b).join(","), "s");
    return [
      s(f.minute),
      s(f.hour),
      s(f.dayOfMonth),
      s(f.month),
      s(f.dayOfWeek),
      f.domIsWild ? "W" : "",
      f.dowIsWild ? "W" : ""
    ].join("|");
  } catch {
    return null;
  }
}
__name(canonicalCron, "canonicalCron");
function registerScheduledTaskCrudRoutes(app, deps) {
  const {
    prefix,
    resolveTarget,
    mutate,
    safeBody,
    channelDeliveryAuthorizations
  } = deps;
  const base = `${prefix}/scheduled-tasks`;
  const withTarget = /* @__PURE__ */ __name((handler) => async (req, res) => {
    const target = resolveTarget(req, res);
    if (!target) return;
    const operation = /* @__PURE__ */ __name(async () => {
      if (!requireOpenGeneration(target, res)) return;
      await handler(req, res, target);
    }, "operation");
    try {
      if (target.activity) {
        await target.activity.run(operation);
      } else {
        await operation();
      }
    } catch (error) {
      if (sendActivityGateError(res, error)) return;
      throw error;
    }
  }, "withTarget");
  app.get(
    base,
    withTarget(async (_req, res, target) => {
      try {
        const tasks = await runWithScheduledTaskTarget(
          target,
          () => readCronTasks(target.workspaceCwd)
        );
        if (!requireOpenGeneration(target, res)) return;
        res.status(200).json({ v: 1, tasks: tasks.map(toView) });
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        writeStderrLine(
          `qwen serve: GET ${base} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        res.status(500).json({
          error: "Failed to read scheduled tasks (the tasks file may be corrupt)",
          code: "scheduled_tasks_read_failed"
        });
      }
    })
  );
  app.post(
    base,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const body = safeBody(req);
      const cron = typeof body["cron"] === "string" ? body["cron"].trim() : "";
      if (cron.length === 0) {
        res.status(400).json({
          error: "`cron` is required and must be a non-empty string",
          code: "invalid_cron"
        });
        return;
      }
      if (cron.length > MAX_CRON_LENGTH) {
        res.status(400).json({
          error: `\`cron\` exceeds ${MAX_CRON_LENGTH}-character limit`,
          code: "invalid_cron"
        });
        return;
      }
      const cronError = validateCron(cron);
      if (cronError) {
        res.status(400).json({ error: cronError, code: "invalid_cron" });
        return;
      }
      const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
      if (prompt.length === 0) {
        res.status(400).json({
          error: "`prompt` is required and must be a non-empty string",
          code: "invalid_prompt"
        });
        return;
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        res.status(400).json({
          error: `\`prompt\` exceeds ${MAX_PROMPT_LENGTH}-character limit`,
          code: "invalid_prompt"
        });
        return;
      }
      const nameResult = parseNameField(body["name"]);
      if (nameResult.error) {
        res.status(400).json({ error: nameResult.error, code: "invalid_name" });
        return;
      }
      if (body["recurring"] !== void 0 && typeof body["recurring"] !== "boolean") {
        res.status(400).json({
          error: "`recurring` must be a boolean",
          code: "invalid_recurring"
        });
        return;
      }
      if (body["enabled"] !== void 0 && typeof body["enabled"] !== "boolean") {
        res.status(400).json({
          error: "`enabled` must be a boolean",
          code: "invalid_enabled"
        });
        return;
      }
      const sessionMode = body["sessionMode"] === void 0 ? "persistent" : body["sessionMode"];
      if (sessionMode !== "persistent" && sessionMode !== "per_run") {
        res.status(400).json({
          error: '`sessionMode` must be "persistent" or "per_run"',
          code: "invalid_session_mode"
        });
        return;
      }
      const modelServiceId = body["modelServiceId"];
      if (modelServiceId !== void 0 && !isValidCronTaskRoutingId(modelServiceId)) {
        res.status(400).json({
          error: `\`modelServiceId\` must be a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters without control characters`,
          code: "invalid_model_service_id"
        });
        return;
      }
      const groupId = body["groupId"];
      if (groupId !== void 0 && !isValidCronTaskRoutingId(groupId)) {
        res.status(400).json({
          error: `\`groupId\` must be a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters without control characters`,
          code: "invalid_group_id"
        });
        return;
      }
      if (sessionMode !== "per_run" && (modelServiceId !== void 0 || groupId !== void 0)) {
        res.status(400).json({
          error: '`modelServiceId` and `groupId` are only supported when `sessionMode` is "per_run"',
          code: "session_routing_requires_per_run"
        });
        return;
      }
      if (typeof groupId === "string") {
        const groups = await runWithScheduledTaskTarget(
          target,
          () => createSessionOrganizationService(workspaceCwd).listGroups()
        );
        if (!groups.groups.some((group) => group.id === groupId)) {
          res.status(400).json({
            error: `Group not found: ${groupId}`,
            code: "group_not_found"
          });
          return;
        }
      }
      const parsedSessionId = parseCallerSuppliedSessionId(body["sessionId"]);
      if (parsedSessionId.kind === "invalid") {
        res.status(400).json({
          error: '`sessionId` must be an RFC UUID v1-v5 (e.g. "550e8400-e29b-41d4-a716-446655440000")',
          code: "invalid_session_id"
        });
        return;
      }
      const providedSessionId = parsedSessionId.kind === "valid" ? parsedSessionId.sessionId : void 0;
      let delivery;
      if (body["delivery"] !== void 0) {
        try {
          delivery = parseChannelDelivery(body["delivery"]);
        } catch (err) {
          if (!isChannelDeliveryError(err)) throw err;
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
      }
      if (sessionMode === "per_run" && delivery !== void 0) {
        res.status(400).json({
          error: "Per-run sessions do not support channel delivery",
          code: "session_mode_delivery_unsupported"
        });
        return;
      }
      const removedField = findRemovedTaskField(body);
      if (removedField) {
        res.status(400).json(removedFieldError(removedField));
        return;
      }
      const recurring = body["recurring"] !== false;
      const enabled = body["enabled"] !== false;
      const taskId = generateCronTaskId();
      if (sessionMode === "per_run" && (!bridge || !bridge.sendPrompt)) {
        res.status(409).json({
          error: "Fresh-session dispatch is not available for this workspace",
          code: "session_mode_unavailable"
        });
        return;
      }
      if (providedSessionId !== void 0) {
        try {
          const task2 = await createScheduledTaskWithExistingSession(
            target,
            {
              sessionId: providedSessionId,
              cron,
              prompt,
              recurring,
              enabled,
              sessionMode,
              ...typeof modelServiceId === "string" ? { modelServiceId } : {},
              ...typeof groupId === "string" ? { groupId } : {},
              ...delivery !== void 0 ? { delivery } : {},
              ...nameResult.value !== void 0 ? { name: nameResult.value } : {}
            },
            { source: "rest" }
          );
          if (task2.delivery && task2.sessionId) {
            channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
              sessionId: task2.sessionId,
              taskId: task2.id,
              target: task2.delivery.target,
              recurring: task2.recurring,
              lastFiredAt: task2.lastFiredAt ?? void 0
            });
          }
          res.status(201).json(toView(task2));
        } catch (error) {
          if (error instanceof ExistingSessionScheduledTaskCreateError) {
            if (error.code === "workspace_runtime_unavailable") {
              res.set("Retry-After", "1");
            }
            res.status(error.status).json({ error: error.message, code: error.code });
            return;
          }
          if (sendActivityGateError(res, error)) return;
          if (sendGenerationClosedError(res, error)) return;
          writeStderrLine(
            `qwen serve: POST ${base} failed to create a task for session '${providedSessionId}': ${error instanceof Error ? error.message : String(error)}`
          );
          res.status(500).json({
            error: "Failed to create scheduled task",
            code: "scheduled_tasks_write_failed"
          });
        }
        return;
      }
      let boundSessionId;
      let sessionMintedHere = false;
      if (bridge) {
        try {
          const tasks = await runWithScheduledTaskTarget(
            target,
            () => readCronTasks(workspaceCwd)
          );
          if (tasks.length >= MAX_SCHEDULED_TASKS) {
            res.status(409).json({
              error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
              code: "max_tasks_reached"
            });
            return;
          }
        } catch {
        }
        if (!requireOpenGeneration(target, res)) return;
        try {
          const session = await runWithScheduledTaskTarget(
            target,
            () => bridge.spawnOrAttach({
              workspaceCwd,
              sessionScope: "thread",
              sourceType: "scheduled_task",
              sourceId: taskId
            })
          );
          boundSessionId = session.sessionId;
          sessionMintedHere = true;
          if (!requireOpenGeneration(target, res)) {
            await teardownBoundSession(target, boundSessionId);
            return;
          }
          try {
            await runWithScheduledTaskTarget(
              target,
              async () => bridge.updateSessionMetadata(boundSessionId, {
                displayName: scheduledTaskSessionName(
                  nameResult.value ?? prompt
                ),
                titleSource: "auto"
              })
            );
          } catch {
          }
        } catch (err) {
          if (sendActivityGateError(res, err)) return;
          if (sendGenerationClosedError(res, err)) return;
          writeStderrLine(
            `qwen serve: POST ${base} failed to create the task's session: ${err instanceof Error ? err.message : String(err)}`
          );
          res.status(500).json({
            error: "Failed to create the task's session",
            code: "scheduled_tasks_session_failed"
          });
          return;
        }
      }
      const now = Date.now();
      const task = {
        id: taskId,
        cron,
        prompt,
        recurring,
        createdAt: now,
        // Pin to the creation minute so the scheduler can't fire during the
        // minute the task was created — same guard cronScheduler.create uses.
        lastFiredAt: now - now % 6e4,
        enabled,
        sessionMode,
        ...typeof modelServiceId === "string" ? { modelServiceId } : {},
        ...typeof groupId === "string" ? { groupId } : {},
        ...delivery !== void 0 ? { delivery } : {},
        ...boundSessionId !== void 0 ? {
          sessionId: boundSessionId
        } : {},
        ...nameResult.value !== void 0 ? { name: nameResult.value } : {}
      };
      const rollbackSession = /* @__PURE__ */ __name(async () => {
        if (boundSessionId !== void 0 && sessionMintedHere) {
          await teardownBoundSession(target, boundSessionId);
        }
      }, "rollbackSession");
      let overCap = false;
      let rollbackBefore;
      let rollbackAfter;
      try {
        await runWithScheduledTaskTarget(
          target,
          () => updateCronTasks(
            workspaceCwd,
            (tasks) => {
              if (tasks.length >= MAX_SCHEDULED_TASKS) {
                overCap = true;
                return tasks;
              }
              rollbackBefore = tasks;
              rollbackAfter = [...tasks, task];
              return rollbackAfter;
            },
            { assertCanCommit: target.assertGenerationOpen }
          )
        );
      } catch (err) {
        await rollbackSession();
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: POST ${base} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        res.status(500).json({
          error: "Failed to create scheduled task",
          code: "scheduled_tasks_write_failed"
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `POST ${base}`
          );
          await rollbackSession();
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (overCap) {
        await rollbackSession();
        res.status(409).json({
          error: `Maximum number of scheduled tasks (${MAX_SCHEDULED_TASKS}) reached`,
          code: "max_tasks_reached"
        });
        return;
      }
      if (task.delivery && task.sessionId) {
        channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
          sessionId: task.sessionId,
          taskId: task.id,
          target: task.delivery.target,
          recurring: task.recurring,
          lastFiredAt: task.lastFiredAt ?? void 0
        });
      }
      res.status(201).json(toView(task));
    })
  );
  app.patch(
    `${base}/:id`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const id = typeof req.params["id"] === "string" ? req.params["id"] : "";
      if (id.length === 0) {
        res.status(400).json({ error: "Task id is required", code: "invalid_id" });
        return;
      }
      const body = safeBody(req);
      const patch = {};
      let clearName = false;
      let clearDelivery = false;
      let clearModelServiceId = false;
      let clearGroupId = false;
      let missingGroupId;
      const removedPatchField = findRemovedTaskField(body);
      if (removedPatchField) {
        res.status(400).json(removedFieldError(removedPatchField));
        return;
      }
      if ("cron" in body) {
        const cron = typeof body["cron"] === "string" ? body["cron"].trim() : "";
        if (cron.length === 0 || cron.length > MAX_CRON_LENGTH) {
          res.status(400).json({
            error: "`cron` must be a non-empty string within the length limit",
            code: "invalid_cron"
          });
          return;
        }
        const cronError = validateCron(cron);
        if (cronError) {
          res.status(400).json({ error: cronError, code: "invalid_cron" });
          return;
        }
        patch.cron = cron;
      }
      if ("prompt" in body) {
        const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
        if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
          res.status(400).json({
            error: "`prompt` must be a non-empty string within the length limit",
            code: "invalid_prompt"
          });
          return;
        }
        patch.prompt = prompt;
      }
      if ("name" in body) {
        const nameResult = parseNameField(body["name"]);
        if (nameResult.error) {
          res.status(400).json({ error: nameResult.error, code: "invalid_name" });
          return;
        }
        if (nameResult.value === void 0) {
          clearName = true;
        } else {
          patch.name = nameResult.value;
        }
      }
      if ("recurring" in body) {
        if (typeof body["recurring"] !== "boolean") {
          res.status(400).json({
            error: "`recurring` must be a boolean",
            code: "invalid_recurring"
          });
          return;
        }
        patch.recurring = body["recurring"];
      }
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          res.status(400).json({
            error: "`enabled` must be a boolean",
            code: "invalid_enabled"
          });
          return;
        }
        patch.enabled = body["enabled"];
      }
      if ("sessionMode" in body) {
        if (body["sessionMode"] !== "persistent" && body["sessionMode"] !== "per_run") {
          res.status(400).json({
            error: '`sessionMode` must be "persistent" or "per_run"',
            code: "invalid_session_mode"
          });
          return;
        }
        patch.sessionMode = body["sessionMode"];
      }
      if ("modelServiceId" in body) {
        const value = body["modelServiceId"];
        if (value === null || value === "") {
          clearModelServiceId = true;
        } else if (!isValidCronTaskRoutingId(value)) {
          res.status(400).json({
            error: `\`modelServiceId\` must be null or a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters without control characters`,
            code: "invalid_model_service_id"
          });
          return;
        } else {
          patch.modelServiceId = value;
        }
      }
      if ("groupId" in body) {
        const value = body["groupId"];
        if (value === null || value === "") {
          clearGroupId = true;
        } else if (!isValidCronTaskRoutingId(value)) {
          res.status(400).json({
            error: `\`groupId\` must be null or a non-empty string of at most ${MAX_ROUTING_ID_LENGTH} characters without control characters`,
            code: "invalid_group_id"
          });
          return;
        } else {
          const groups = await runWithScheduledTaskTarget(
            target,
            () => createSessionOrganizationService(workspaceCwd).listGroups()
          );
          if (!groups.groups.some((group) => group.id === value)) {
            missingGroupId = value;
          }
          patch.groupId = value;
        }
      }
      if ("delivery" in body) {
        if (body["delivery"] === null) {
          clearDelivery = true;
        } else {
          try {
            patch.delivery = parseChannelDelivery(body["delivery"]);
          } catch (err) {
            if (!isChannelDeliveryError(err)) throw err;
            res.status(400).json({ error: err.message, code: err.code });
            return;
          }
        }
      }
      if (Object.keys(patch).length === 0 && !clearName && !clearDelivery && !clearModelServiceId && !clearGroupId) {
        res.status(400).json({
          error: "No updatable fields provided",
          code: "empty_patch"
        });
        return;
      }
      let found = false;
      let updated;
      let blockedByArchive = false;
      let blockedLegacy = false;
      let blockedSessionModeDelivery = false;
      let blockedSessionModeUnavailable = false;
      let blockedSessionModeUnbound = false;
      let blockedGroupNotFound = false;
      let rollbackBefore;
      let rollbackAfter;
      try {
        await runWithScheduledTaskTarget(
          target,
          () => updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks;
              found = true;
              const current = tasks[idx];
              if (missingGroupId !== void 0 && current.groupId !== missingGroupId) {
                blockedGroupNotFound = true;
                return tasks;
              }
              const convertingToPerRun = patch.sessionMode === "per_run" && current.sessionMode !== "per_run";
              if (convertingToPerRun && (!bridge || !bridge.sendPrompt)) {
                blockedSessionModeUnavailable = true;
                return tasks;
              }
              if (convertingToPerRun && !current.sessionId) {
                blockedSessionModeUnbound = true;
                return tasks;
              }
              if (patch.enabled === true && taskHasLegacyCondition(current)) {
                blockedLegacy = true;
                return tasks;
              }
              if (patch.enabled === true && current.disabledByArchive === true) {
                blockedByArchive = true;
                return tasks;
              }
              const next = { ...current, ...patch };
              if (clearName) delete next.name;
              if (clearDelivery) delete next.delivery;
              if (clearModelServiceId) delete next.modelServiceId;
              if (clearGroupId) delete next.groupId;
              if (next.sessionMode !== "per_run") {
                delete next.modelServiceId;
                delete next.groupId;
              }
              if (next.sessionMode === "per_run" && next.delivery) {
                blockedSessionModeDelivery = true;
                return tasks;
              }
              const justReEnabled = current.enabled === false && patch.enabled === true;
              const cronChanged = patch.cron !== void 0 && canonicalCron(patch.cron) !== canonicalCron(current.cron);
              const becameRecurring = patch.recurring === true && current.recurring !== true;
              const becameOneShot = patch.recurring === false && current.recurring !== false;
              const retryFailedOneShot = !next.recurring && justReEnabled && !cronChanged && !becameOneShot && current.runs?.at(-1)?.sessionDispatchFailed === true;
              {
                const now = Date.now();
                const minute = now - now % 6e4;
                if (next.recurring && (justReEnabled || cronChanged || becameRecurring)) {
                  next.lastFiredAt = minute;
                } else if (!next.recurring && !retryFailedOneShot && (justReEnabled || cronChanged || becameOneShot)) {
                  next.createdAt = now;
                  next.lastFiredAt = minute;
                }
              }
              updated = next;
              rollbackBefore = tasks;
              rollbackAfter = tasks.map((t, i) => i === idx ? next : t);
              return rollbackAfter;
            },
            { assertCanCommit: target.assertGenerationOpen }
          )
        );
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: PATCH ${base}/${id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        res.status(500).json({
          error: "Failed to update scheduled task",
          code: "scheduled_tasks_write_failed"
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `PATCH ${base}/${id}`
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (!found) {
        res.status(404).json({ error: "Task not found", code: "task_not_found" });
        return;
      }
      if (missingGroupId !== void 0 && blockedGroupNotFound) {
        res.status(400).json({
          error: `Group not found: ${missingGroupId}`,
          code: "group_not_found"
        });
        return;
      }
      if (blockedLegacy) {
        res.status(409).json({
          error: "This task uses the removed isolated run mode with a precondition and can no longer be enabled or run. Recreate it (and call the `create_sub_session` tool from the prompt if you need per-run isolation).",
          code: "task_legacy_unsupported"
        });
        return;
      }
      if (blockedByArchive) {
        res.status(409).json({
          error: "This task was disabled by archiving its session; unarchive the session to re-enable it.",
          code: "task_session_archived"
        });
        return;
      }
      if (blockedSessionModeUnavailable) {
        res.status(409).json({
          error: "Fresh-session dispatch is not available for this workspace",
          code: "session_mode_unavailable"
        });
        return;
      }
      if (blockedSessionModeUnbound) {
        res.status(409).json({
          error: "This task is not bound to a session yet, so it cannot run in a new session every run. Try again once it has run or been opened at least once.",
          code: "session_mode_requires_bound_session"
        });
        return;
      }
      if (blockedSessionModeDelivery) {
        res.status(409).json({
          error: "Per-run sessions do not support channel delivery",
          code: "session_mode_delivery_unsupported"
        });
        return;
      }
      if (!updated) {
        res.status(404).json({ error: "Task not found", code: "task_not_found" });
        return;
      }
      const effectiveLabelChanged = patch.name !== void 0 || clearName || patch.prompt !== void 0 && updated.name === void 0;
      if (bridge && updated.sessionId && updated.sessionOwnedByTask !== false && effectiveLabelChanged) {
        try {
          bridge.updateSessionMetadata(updated.sessionId, {
            displayName: scheduledTaskSessionName(
              updated.name ?? updated.prompt
            ),
            titleSource: "auto"
          });
        } catch {
        }
      }
      if (updated.delivery && updated.sessionId) {
        channelDeliveryAuthorizations?.registerScheduledTask(workspaceCwd, {
          sessionId: updated.sessionId,
          taskId: updated.id,
          target: updated.delivery.target,
          recurring: updated.recurring,
          lastFiredAt: updated.lastFiredAt ?? void 0
        });
      }
      if (clearDelivery && updated.sessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          updated.sessionId,
          updated.id
        );
      }
      res.status(200).json(toView(updated));
    })
  );
  app.delete(
    `${base}/:id`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd, bridge } = target;
      const id = typeof req.params["id"] === "string" ? req.params["id"] : "";
      if (id.length === 0) {
        res.status(400).json({ error: "Task id is required", code: "invalid_id" });
        return;
      }
      let boundSessionId;
      let sessionOwnedByTask = true;
      let removed = false;
      let rollbackBefore;
      let rollbackAfter;
      try {
        await runWithScheduledTaskTarget(target, async () => {
          try {
            await access(getCronFilePath(workspaceCwd));
          } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
          }
          await updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks;
              const match = tasks[idx].sessionId;
              if (typeof match === "string" && match.length > 0) {
                boundSessionId = match;
                sessionOwnedByTask = tasks[idx].sessionOwnedByTask !== false;
              }
              removed = true;
              rollbackBefore = tasks;
              rollbackAfter = tasks.filter((_, i) => i !== idx);
              return rollbackAfter;
            },
            {
              assertCanCommit: target.assertGenerationOpen,
              deletionIds: [id]
            }
          );
        });
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: DELETE ${base}/${id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        res.status(500).json({
          error: "Failed to delete scheduled task",
          code: "scheduled_tasks_write_failed"
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `DELETE ${base}/${id}`
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (!removed) {
        res.status(404).json({ error: "Task not found", code: "task_not_found" });
        return;
      }
      if (boundSessionId && sessionOwnedByTask && bridge) {
        try {
          await runWithScheduledTaskTarget(
            target,
            () => bridge.closeSession(boundSessionId)
          );
        } catch (error) {
          if (sendActivityGateError(res, error)) return;
        }
      }
      if (boundSessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          boundSessionId,
          id
        );
      }
      res.status(200).json({ deleted: true, id });
    })
  );
  app.post(
    `${base}/:id/run`,
    mutate(),
    withTarget(async (req, res, target) => {
      const { workspaceCwd } = target;
      const id = typeof req.params["id"] === "string" ? req.params["id"] : "";
      if (id.length === 0) {
        res.status(400).json({ error: "Task id is required", code: "invalid_id" });
        return;
      }
      const now = Date.now();
      let found = false;
      let blockedDisabled = false;
      let blockedLegacy = false;
      let updated;
      let rollbackBefore;
      let rollbackAfter;
      let removalGenerations;
      try {
        await runWithScheduledTaskTarget(
          target,
          () => updateCronTasks(
            workspaceCwd,
            (tasks) => {
              const idx = tasks.findIndex((t) => t.id === id);
              if (idx === -1) return tasks;
              found = true;
              const current = tasks[idx];
              if (taskHasLegacyCondition(current)) {
                blockedLegacy = true;
                return tasks;
              }
              if (current.enabled === false) {
                blockedDisabled = true;
                return tasks;
              }
              const next = {
                ...current,
                lastFiredAt: now,
                runs: appendCronRun(current.runs, {
                  at: now,
                  kind: "manual",
                  ...current.sessionMode !== "per_run" && current.sessionId ? { sessionId: current.sessionId } : {}
                })
              };
              updated = next;
              rollbackBefore = tasks;
              const nextTasks = !current.recurring ? tasks.filter((_, i) => i !== idx) : tasks.map((t, i) => i === idx ? next : t);
              rollbackAfter = nextTasks;
              return nextTasks;
            },
            {
              assertCanCommit: target.assertGenerationOpen,
              observeDeletionIds: /* @__PURE__ */ __name((tasks) => {
                const task = tasks.find((task2) => task2.id === id);
                return task?.sessionId ? [id, cronTaskSessionDeletionId(task.sessionId)] : [id];
              }, "observeDeletionIds"),
              onDeletionGenerations: /* @__PURE__ */ __name((generations) => {
                removalGenerations = generations;
              }, "onDeletionGenerations")
            }
          )
        );
      } catch (err) {
        if (sendActivityGateError(res, err)) return;
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: POST ${base}/${id}/run failed: ${err instanceof Error ? err.message : String(err)}`
        );
        res.status(500).json({
          error: "Failed to record scheduled task run",
          code: "scheduled_tasks_write_failed"
        });
        return;
      }
      if (rollbackBefore && rollbackAfter) {
        try {
          target.assertGenerationOpen?.();
        } catch (error) {
          await rollbackCronMutation(
            target,
            rollbackBefore,
            rollbackAfter,
            `POST ${base}/${id}/run`
          );
          if (sendGenerationClosedError(res, error)) return;
          throw error;
        }
      }
      if (blockedLegacy) {
        res.status(409).json({
          error: "This task uses the removed isolated run mode with a precondition and can no longer run. Recreate it (and call the `create_sub_session` tool from the prompt if you need per-run isolation).",
          code: "task_legacy_unsupported"
        });
        return;
      }
      if (blockedDisabled) {
        res.status(409).json({
          error: "Cannot run a disabled task; enable it first (unarchive its session if it was archived).",
          code: "task_disabled"
        });
        return;
      }
      if (!found || !updated) {
        res.status(404).json({ error: "Task not found", code: "task_not_found" });
        return;
      }
      if (updated.sessionMode === "per_run") {
        const persistOutcome = /* @__PURE__ */ __name(async (outcome) => {
          if (!updated.recurring) return;
          await runWithScheduledTaskTarget(
            target,
            () => updateCronTasks(
              workspaceCwd,
              (tasks) => tasks.map(
                (task) => task.id === id ? annotateCronRunSession(task, now, outcome) : task
              ),
              { assertCanCommit: target.assertGenerationOpen }
            )
          );
        }, "persistOutcome");
        let childSessionId;
        try {
          childSessionId = await dispatchTaskToFreshSession(target, updated);
        } catch (error) {
          updated = annotateCronRunSession(updated, now, {
            dispatchFailed: true
          });
          if (updated.recurring) {
            await persistOutcome({ dispatchFailed: true }).catch(
              (persistError) => {
                writeStderrLine(
                  `qwen serve: POST ${base}/${id}/run could not record the failed dispatch: ${persistError instanceof Error ? persistError.message : String(persistError)}`
                );
              }
            );
          } else {
            await restoreConsumedOneShot(
              target,
              rollbackBefore,
              updated,
              removalGenerations,
              `POST ${base}/${id}/run fresh-session dispatch`
            );
          }
          writeStderrLine(
            `qwen serve: POST ${base}/${id}/run could not create a fresh session: ${error instanceof Error ? error.message : String(error)}`
          );
          res.status(500).json({
            error: "Failed to create a fresh session for the scheduled task",
            code: "scheduled_task_session_dispatch_failed"
          });
          return;
        }
        updated = annotateCronRunSession(updated, now, {
          sessionId: childSessionId
        });
        await persistOutcome({ sessionId: childSessionId }).catch((error) => {
          writeStderrLine(
            `qwen serve: POST ${base}/${id}/run could not attribute fresh session ${childSessionId}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      if (!updated.recurring && updated.sessionId) {
        channelDeliveryAuthorizations?.revokeScheduledTask(
          workspaceCwd,
          updated.sessionId,
          updated.id
        );
      }
      const view = toView(updated);
      if (!updated.recurring) view.nextRunAt = null;
      res.status(200).json(view);
    })
  );
}
__name(registerScheduledTaskCrudRoutes, "registerScheduledTaskCrudRoutes");
function registerScheduledTasksRoutes(app, deps) {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    bridge,
    channelDeliveryAuthorizations
  } = deps;
  registerScheduledTaskCrudRoutes(app, {
    prefix: "",
    resolveTarget: /* @__PURE__ */ __name((_req, res) => {
      const runtime = deps.getRuntime?.();
      if (deps.getRuntime && !runtime) {
        res.set("Retry-After", "1");
        res.status(503).json({
          error: "Workspace runtime is not active",
          code: "workspace_runtime_unavailable"
        });
        return null;
      }
      if (runtime && !requireTrustedWorkspaceRuntime(runtime, res)) return null;
      return {
        workspaceCwd: boundWorkspace,
        ...runtime ? {
          runtimeBaseDir: runtime.sessionRuntimeBaseDir,
          ...deps.cleanupSession ? {
            cleanupSession: /* @__PURE__ */ __name((sessionId) => deps.cleanupSession(runtime, sessionId), "cleanupSession")
          } : {}
        } : {},
        // The runtime bridge only refines an ENABLED deps bridge; it must never
        // re-enable binding when deps `bridge` is undefined. server.ts passes
        // the bridge only when resident task-session management is on, and a
        // bound task must always have something to keep it resident + rehydrate
        // it — the same gate the qualified surface enforces below.
        bridge: bridge === void 0 ? void 0 : runtime?.bridge ?? bridge,
        ...runtime?.generationGuard ? {
          assertGenerationOpen: /* @__PURE__ */ __name(() => runtime.generationGuard?.assertOpen(), "assertGenerationOpen")
        } : {},
        ...deps.workspaceRegistry ? {
          resolveLiveSessionOwner: /* @__PURE__ */ __name((sessionId) => deps.workspaceRegistry.resolveLiveSessionOwner(sessionId), "resolveLiveSessionOwner")
        } : {}
      };
    }, "resolveTarget"),
    mutate,
    safeBody,
    channelDeliveryAuthorizations
  });
}
__name(registerScheduledTasksRoutes, "registerScheduledTasksRoutes");
function registerWorkspaceQualifiedScheduledTasksRoutes(app, deps) {
  const {
    workspaceRegistry,
    mutate,
    safeBody,
    manageScheduledTaskSessions,
    channelDeliveryAuthorizations,
    cleanupSession
  } = deps;
  registerScheduledTaskCrudRoutes(app, {
    prefix: "/workspaces/:workspace",
    resolveTarget: /* @__PURE__ */ __name((req, res) => {
      const runtime = resolveWorkspaceRuntimeWithLiveCompatibilityFromParam(
        workspaceRegistry,
        req,
        res
      );
      if (!runtime) return null;
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return null;
      if (runtime.provenance === "live-conversation" && !deps.conversationRuntimeActivity) {
        sendConversationRuntimeUnavailable(res);
        return null;
      }
      if (runtime.provenance === "live-conversation" && req.method === "POST" && req.params["id"] === void 0 && parseCallerSuppliedSessionId(safeBody(req)["sessionId"]).kind === "absent") {
        res.status(400).json({
          error: "Generic scheduled tasks cannot create sessions in the Conversations workspace.",
          code: "live_session_creation_reserved"
        });
        return null;
      }
      return {
        workspaceCwd: runtime.workspaceCwd,
        runtimeBaseDir: runtime.sessionRuntimeBaseDir,
        ...runtime.provenance === "live-conversation" && deps.conversationRuntimeActivity ? { activity: deps.conversationRuntimeActivity } : {},
        ...cleanupSession ? {
          cleanupSession: /* @__PURE__ */ __name((sessionId) => cleanupSession(runtime, sessionId), "cleanupSession")
        } : {},
        // Mirror the primary surface: only bind a session when management is on,
        // so a bound task always has something to keep it resident + rehydrate it.
        bridge: manageScheduledTaskSessions ? runtime.bridge : void 0,
        ...runtime.generationGuard ? {
          assertGenerationOpen: /* @__PURE__ */ __name(() => runtime.generationGuard?.assertOpen(), "assertGenerationOpen")
        } : {},
        resolveLiveSessionOwner: /* @__PURE__ */ __name((sessionId) => workspaceRegistry.resolveLiveSessionOwner(sessionId), "resolveLiveSessionOwner")
      };
    }, "resolveTarget"),
    mutate,
    safeBody,
    channelDeliveryAuthorizations
  });
}
__name(registerWorkspaceQualifiedScheduledTasksRoutes, "registerWorkspaceQualifiedScheduledTasksRoutes");
var REMOVED_TASK_FIELDS = ["runMode", "condition"];
function findRemovedTaskField(body) {
  return REMOVED_TASK_FIELDS.find((field) => field in body);
}
__name(findRemovedTaskField, "findRemovedTaskField");
function removedFieldError(field) {
  return {
    error: `\`${field}\` is no longer supported: the isolated scheduled-task run mode was removed. Every task now runs in its bound session; call the \`create_sub_session\` tool from the task prompt for per-run isolation.`,
    code: "unsupported_field"
  };
}
__name(removedFieldError, "removedFieldError");
function parseNameField(raw) {
  if (raw === void 0 || raw === null) return { value: void 0 };
  if (typeof raw !== "string") {
    return { error: "`name` must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: void 0 };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { error: `\`name\` exceeds ${MAX_NAME_LENGTH}-character limit` };
  }
  return { value: trimmed };
}
__name(parseNameField, "parseNameField");

export {
  resolveWorkspaceEntryFromParam,
  isPortableAbsolutePath,
  resolveRegisteredWorkspaceRuntimeByPathSelector,
  resolveManagedWorkspaceRuntimeByPathSelector,
  resolveWorkspaceRuntimeFromParam,
  resolveTrustedRuntime,
  resolveWorkspaceRuntimeWithLiveCompatibilityFromParam,
  sendConversationRuntimeUnavailable,
  sendWorkspaceRuntimeUnavailable,
  isGenerationClosedError,
  sendGenerationClosedError,
  resolveManagedWorkspaceRuntimeFromParam,
  requireTrustedWorkspaceRuntime,
  sendUntrustedWorkspaceResponse,
  getWorkspaceRouteContext,
  setWorkspaceRouteContext,
  resolveContainedCwd,
  resolveContainedCwdOrFail,
  scheduledTaskSessionName,
  ExistingSessionScheduledTaskCreateError,
  createScheduledTaskWithExistingSession,
  registerScheduledTasksRoutes,
  registerWorkspaceQualifiedScheduledTasksRoutes
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
