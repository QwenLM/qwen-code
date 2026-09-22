// Force strict mode and setup for ESM
"use strict";
import {
  getTasksDir,
  sanitizeName
} from "./chunk-YVYK3JYU.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  Mutex
} from "./chunk-VGC4I5JJ.js";
import {
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/team/tasks.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
var debug = createDebugLogger("AGENTS_TEAM_TASKS");
var MAX_METADATA_BYTES = 32768;
var MAX_PARALLEL_TASK_READS = 16;
function assertMetadataWithinLimit(metadata) {
  if (!metadata) return;
  const size = Buffer.byteLength(JSON.stringify(metadata), "utf-8");
  if (size > MAX_METADATA_BYTES) {
    throw new Error(
      `Task metadata is too large (${size} bytes; max ${MAX_METADATA_BYTES}). Trim the payload or store the bulk content elsewhere.`
    );
  }
}
__name(assertMetadataWithinLimit, "assertMetadataWithinLimit");
var LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    // Jitter the backoff so in-process and cross-process contenders
    // don't retry in lockstep (thundering herd) and starve each other
    // out of the retry budget — mirrors mailbox.ts. The most acute case
    // is scanIdleAgentsForTasks racing up to MAX_TEAMMATES claimants at
    // the same first-pending task file.
    randomize: true
  },
  stale: 5e3,
  onCompromised: /* @__PURE__ */ __name((err) => {
    debug.warn("task lock compromised:", err);
  }, "onCompromised")
};
var taskFileLocks = /* @__PURE__ */ new Map();
function getTaskFileLock(taskPath) {
  let lock = taskFileLocks.get(taskPath);
  if (!lock) {
    lock = new Mutex();
    taskFileLocks.set(taskPath, lock);
  }
  return lock;
}
__name(getTaskFileLock, "getTaskFileLock");
async function withTaskFileLock(taskPath, fn, onMissing) {
  return getTaskFileLock(taskPath).runExclusive(async () => {
    let release;
    try {
      release = await import_proper_lockfile.default.lock(taskPath, LOCK_OPTIONS);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return onMissing();
      throw err;
    }
    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch (error) {
        debug.warn("Failed to release task lock:", error);
      }
    }
  });
}
__name(withTaskFileLock, "withTaskFileLock");
var RECIPROCAL_CALLER = "__reciprocal__";
var agentClaimLocks = /* @__PURE__ */ new Map();
function getAgentClaimLock(agentId) {
  let lock = agentClaimLocks.get(agentId);
  if (!lock) {
    lock = new Mutex();
    agentClaimLocks.set(agentId, lock);
  }
  return lock;
}
__name(getAgentClaimLock, "getAgentClaimLock");
function assertValidTaskId(taskId) {
  if (!/^[1-9]\d*$/.test(taskId)) {
    throw new Error(
      `Invalid task ID "${taskId}". Task IDs must be positive integers.`
    );
  }
}
__name(assertValidTaskId, "assertValidTaskId");
function normalizeTaskId(raw) {
  const id = raw.trim().replace(/^#/, "");
  return id === "" ? void 0 : id;
}
__name(normalizeTaskId, "normalizeTaskId");
function getTaskPath(teamName, taskId) {
  assertValidTaskId(taskId);
  return path.join(getTasksDir(teamName), `${taskId}.json`);
}
__name(getTaskPath, "getTaskPath");
var listeners = /* @__PURE__ */ new Set();
function onTasksUpdated(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
__name(onTasksUpdated, "onTasksUpdated");
function notifyTasksUpdated(teamName) {
  for (const listener of listeners) {
    try {
      listener(teamName);
    } catch (err) {
      debug.warn(`task update listener failed: ${err}`);
    }
  }
}
__name(notifyTasksUpdated, "notifyTasksUpdated");
async function createTask(teamName, opts) {
  assertMetadataWithinLimit(opts.metadata);
  const dir = getTasksDir(teamName);
  await fs.mkdir(dir, { recursive: true });
  const MAX_RETRIES = 15;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const nextId = await getNextTaskId(dir);
    const task = {
      id: nextId,
      subject: opts.subject,
      description: opts.description,
      activeForm: opts.activeForm,
      owner: opts.owner,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: opts.metadata
    };
    const taskPath = path.join(dir, `${nextId}.json`);
    try {
      const handle = await fs.open(
        taskPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      );
      await handle.close();
    } catch (err) {
      if (isNodeError(err) && err.code === "EEXIST") {
        continue;
      }
      throw err;
    }
    try {
      await atomicWriteJSON(taskPath, task);
    } catch (err) {
      await fs.unlink(taskPath).catch(() => {
      });
      throw err;
    }
    notifyTasksUpdated(teamName);
    return task;
  }
  throw new Error(
    `Failed to create task after ${MAX_RETRIES} attempts (ID contention).`
  );
}
__name(createTask, "createTask");
async function getTask(teamName, taskId) {
  const taskPath = getTaskPath(teamName, taskId);
  try {
    const raw = await fs.readFile(taskPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return void 0;
    throw err;
  }
}
__name(getTask, "getTask");
var TaskOwnershipError = class extends Error {
  constructor(taskId, callerName, actualOwner) {
    super(
      `Task #${taskId} is owned by "${actualOwner}". Only the leader or the owner can change status / owner / subject / description / blocks.`
    );
    this.taskId = taskId;
    this.callerName = callerName;
    this.actualOwner = actualOwner;
    this.name = "TaskOwnershipError";
  }
  static {
    __name(this, "TaskOwnershipError");
  }
};
var TaskSnapshotChangedError = class extends Error {
  constructor(taskId, expectedOwner, actualOwner, expectedStatus, actualStatus, checksExpectedOwner, checksExpectedStatus) {
    const label = /* @__PURE__ */ __name((owner) => owner ?? "unassigned", "label");
    const changes = [];
    if (checksExpectedOwner && expectedOwner !== actualOwner) {
      changes.push(
        `owner changed from "${label(expectedOwner)}" to "${label(actualOwner)}"`
      );
    }
    if (checksExpectedStatus && expectedStatus !== actualStatus) {
      changes.push(
        `status changed from "${expectedStatus}" to "${actualStatus}"`
      );
    }
    super(
      `Task #${taskId} ${changes.join(" and ")} before this update committed. Current state is owner "${label(actualOwner)}", status "${actualStatus}". Re-read the task before retrying.`
    );
    this.taskId = taskId;
    this.expectedOwner = expectedOwner;
    this.actualOwner = actualOwner;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
    this.name = "TaskSnapshotChangedError";
  }
  static {
    __name(this, "TaskSnapshotChangedError");
  }
};
async function updateTask(teamName, taskId, updates, opts) {
  const taskPath = getTaskPath(teamName, taskId);
  return withTaskFileLock(
    taskPath,
    async () => {
      let raw;
      try {
        raw = await fs.readFile(taskPath, "utf-8");
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return void 0;
        throw err;
      }
      const task = JSON.parse(raw);
      const checksExpectedOwner = opts !== void 0 && "expectedOwner" in opts;
      const checksExpectedStatus = opts?.expectedStatus !== void 0;
      if (checksExpectedOwner || checksExpectedStatus) {
        const expectedOwner = opts.expectedOwner ? sanitizeName(opts.expectedOwner) : void 0;
        const actualOwner = task.owner ? sanitizeName(task.owner) : void 0;
        if (checksExpectedOwner && expectedOwner !== actualOwner || checksExpectedStatus && opts.expectedStatus !== task.status) {
          throw new TaskSnapshotChangedError(
            taskId,
            expectedOwner,
            actualOwner,
            opts.expectedStatus,
            task.status,
            checksExpectedOwner,
            checksExpectedStatus
          );
        }
      }
      if (opts?.callerName !== void 0 && opts.callerName !== RECIPROCAL_CALLER) {
        const restrictsOwnership = updates.status !== void 0 || updates.owner !== void 0 || updates.subject !== void 0 || updates.description !== void 0 || (updates.addBlocks?.length ?? 0) > 0 || (updates.addBlockedBy?.length ?? 0) > 0;
        if (restrictsOwnership && task.owner && task.owner !== opts.callerName) {
          throw new TaskOwnershipError(taskId, opts.callerName, task.owner);
        }
      }
      if (updates.addBlocks?.length) {
        const blockSet = new Set(task.blocks);
        for (const id of updates.addBlocks) blockSet.add(id);
        task.blocks = Array.from(blockSet);
      }
      if (updates.addBlockedBy?.length) {
        const blockedBySet = new Set(task.blockedBy);
        for (const id of updates.addBlockedBy) blockedBySet.add(id);
        task.blockedBy = Array.from(blockedBySet);
      }
      if (updates.status !== void 0) {
        task.status = updates.status;
        if (updates.status === "completed" && task.blocks.length > 0) {
          await unblockDependents(teamName, taskId, task.blocks);
        }
      }
      if (updates.owner !== void 0) {
        task.owner = updates.owner ? updates.owner : void 0;
      }
      if (updates.subject !== void 0) {
        task.subject = updates.subject;
      }
      if (updates.description !== void 0) {
        task.description = updates.description;
      }
      if (updates.activeForm !== void 0) {
        task.activeForm = updates.activeForm ?? void 0;
      }
      if (updates.metadata !== void 0) {
        task.metadata = task.metadata ?? {};
        for (const [key, value] of Object.entries(updates.metadata)) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
          }
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        if (Object.keys(task.metadata).length === 0) {
          task.metadata = void 0;
        }
        assertMetadataWithinLimit(task.metadata);
      }
      await atomicWriteJSON(taskPath, task);
      notifyTasksUpdated(teamName);
      return task;
    },
    () => void 0
  );
}
__name(updateTask, "updateTask");
async function deleteTask(teamName, taskId, opts) {
  const taskPath = getTaskPath(teamName, taskId);
  const dependentIds = await withTaskFileLock(
    taskPath,
    async () => {
      let task;
      try {
        const raw = await fs.readFile(taskPath, "utf-8");
        task = JSON.parse(raw);
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return null;
        throw err;
      }
      if (opts?.callerName !== void 0 && task.owner && task.owner !== opts.callerName) {
        throw new TaskOwnershipError(taskId, opts.callerName, task.owner);
      }
      const deps = /* @__PURE__ */ new Set([...task.blocks, ...task.blockedBy]);
      deps.delete(taskId);
      try {
        await fs.unlink(taskPath);
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return null;
        throw err;
      }
      return deps;
    },
    () => null
  );
  if (dependentIds === null) return false;
  const results = await Promise.allSettled(
    Array.from(dependentIds).map(
      (depId) => removeEdgesReferencing(teamName, depId, taskId)
    )
  );
  for (const r of results) {
    if (r.status === "rejected") {
      debug.warn(`deleteTask(${taskId}): edge cleanup failed: ${r.reason}`);
    }
  }
  notifyTasksUpdated(teamName);
  return true;
}
__name(deleteTask, "deleteTask");
async function removeEdgesReferencing(teamName, targetId, referencedId) {
  const depPath = getTaskPath(teamName, targetId);
  await withTaskFileLock(
    depPath,
    async () => {
      try {
        const raw = await fs.readFile(depPath, "utf-8");
        const task = JSON.parse(raw);
        const beforeBlocks = task.blocks.length;
        const beforeBlockedBy = task.blockedBy.length;
        task.blocks = task.blocks.filter((id) => id !== referencedId);
        task.blockedBy = task.blockedBy.filter((id) => id !== referencedId);
        if (task.blocks.length === beforeBlocks && task.blockedBy.length === beforeBlockedBy) {
          return;
        }
        await atomicWriteJSON(depPath, task);
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return;
        throw err;
      }
    },
    () => void 0
  );
}
__name(removeEdgesReferencing, "removeEdgesReferencing");
async function listTasks(teamName, filters) {
  const dir = getTasksDir(teamName);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    const errMsg = err instanceof Error ? err.message : String(err);
    debug.warn(`Failed to list tasks dir ${dir}: ${errMsg}`);
    throw err instanceof Error ? err : new Error(errMsg);
  }
  const jsonEntries = entries.filter((e) => e.endsWith(".json"));
  const reads = [];
  for (let i = 0; i < jsonEntries.length; i += MAX_PARALLEL_TASK_READS) {
    const batch = jsonEntries.slice(i, i + MAX_PARALLEL_TASK_READS);
    const batchReads = await Promise.all(
      batch.map(async (entry) => {
        const filePath = path.join(dir, entry);
        let raw;
        try {
          raw = await fs.readFile(filePath, "utf-8");
        } catch (err) {
          if (isNodeError(err) && err.code === "ENOENT") return void 0;
          const errMsg = err instanceof Error ? err.message : String(err);
          debug.warn(`Failed to read task file ${filePath}: ${errMsg}`);
          return void 0;
        }
        if (raw.trim() === "") {
          return void 0;
        }
        try {
          return JSON.parse(raw);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debug.warn(`Quarantining corrupt task file ${filePath}: ${errMsg}`);
          const quarantined = `${filePath}.corrupt-${Date.now()}`;
          try {
            await fs.rename(filePath, quarantined);
          } catch (renameErr) {
            const renameMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
            debug.warn(`Failed to quarantine ${filePath}: ${renameMsg}`);
          }
          return void 0;
        }
      })
    );
    reads.push(...batchReads);
  }
  const tasks = reads.filter((t) => t !== void 0);
  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  if (!filters) return tasks;
  return tasks.filter((t) => {
    if (filters.status !== void 0 && t.status !== filters.status) {
      return false;
    }
    if (filters.owner !== void 0 && // Match on canonical identities both ways: owners persisted
    // before the sanitization landed (#9282) keep their raw spelling
    // on disk and would otherwise never match any filter.
    sanitizeName(t.owner ?? "") !== sanitizeName(filters.owner)) {
      return false;
    }
    if (filters.blockedBy !== void 0 && !t.blockedBy.includes(filters.blockedBy)) {
      return false;
    }
    return true;
  });
}
__name(listTasks, "listTasks");
async function resetTaskList(teamName) {
  const dir = getTasksDir(teamName);
  await fs.rm(dir, { recursive: true, force: true });
  notifyTasksUpdated(teamName);
}
__name(resetTaskList, "resetTaskList");
async function unblockDependents(teamName, completedId, dependentIds) {
  const results = await Promise.allSettled(
    dependentIds.map(async (depId) => {
      const depPath = getTaskPath(teamName, depId);
      await withTaskFileLock(
        depPath,
        async () => {
          let raw;
          try {
            raw = await fs.readFile(depPath, "utf-8");
          } catch (err) {
            if (isNodeError(err) && err.code === "ENOENT") return;
            throw err;
          }
          const task = JSON.parse(raw);
          const before = task.blockedBy.length;
          task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
          if (task.blockedBy.length === before) return;
          await atomicWriteJSON(depPath, task);
        },
        () => void 0
      );
    })
  );
  for (const r of results) {
    if (r.status === "rejected") {
      debug.warn(`unblockDependents(${completedId}): ${r.reason}`);
    }
  }
  notifyTasksUpdated(teamName);
}
__name(unblockDependents, "unblockDependents");
async function claimTask(teamName, taskId, agentId, opts) {
  if (opts?.checkAgentBusy) {
    return getAgentClaimLock(agentId).runExclusive(
      () => claimTaskLocked(teamName, taskId, agentId, opts, true)
    );
  }
  return claimTaskLocked(teamName, taskId, agentId, opts, false);
}
__name(claimTask, "claimTask");
async function claimTaskLocked(teamName, taskId, agentId, opts, checkBusy) {
  if (checkBusy) {
    const busy = await isAgentBusy(teamName, agentId);
    if (busy) return void 0;
  }
  const taskPath = getTaskPath(teamName, taskId);
  return withTaskFileLock(
    taskPath,
    async () => {
      let raw;
      try {
        raw = await fs.readFile(taskPath, "utf-8");
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return void 0;
        throw err;
      }
      const task = JSON.parse(raw);
      if (task.status !== "pending") return void 0;
      if (task.owner) return void 0;
      task.owner = opts?.ownerName ?? agentId;
      task.status = "in_progress";
      await atomicWriteJSON(taskPath, task);
      notifyTasksUpdated(teamName);
      return task;
    },
    () => void 0
  );
}
__name(claimTaskLocked, "claimTaskLocked");
async function isAgentBusy(teamName, agentId) {
  const inProgress = await listTasks(teamName, {
    status: "in_progress"
  });
  const bareName = agentId.split("@")[0];
  return inProgress.some((t) => t.owner === agentId || t.owner === bareName);
}
__name(isAgentBusy, "isAgentBusy");
async function releaseOwnedTask(teamName, taskId, expectedOwner) {
  const taskPath = getTaskPath(teamName, taskId);
  return withTaskFileLock(
    taskPath,
    async () => {
      let raw;
      try {
        raw = await fs.readFile(taskPath, "utf-8");
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") return false;
        throw err;
      }
      const task = JSON.parse(raw);
      if (task.status !== "in_progress") return false;
      if (task.owner !== expectedOwner) return false;
      task.owner = void 0;
      task.status = "pending";
      await atomicWriteJSON(taskPath, task);
      return true;
    },
    () => false
  );
}
__name(releaseOwnedTask, "releaseOwnedTask");
async function unassignTeammateTasks(teamName, agentId) {
  const bareName = agentId.split("@")[0];
  const inProgress = await listTasks(teamName, {
    status: "in_progress"
  });
  const owned = inProgress.filter(
    (task) => task.owner === agentId || task.owner === bareName
  );
  const results = await Promise.allSettled(
    owned.map((task) => releaseOwnedTask(teamName, task.id, task.owner))
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    debug.warn(
      `unassignTeammateTasks: ${failed.length}/${owned.length} task(s) failed to unassign for ${agentId}`
    );
  }
  const released = results.filter(
    (r) => r.status === "fulfilled" && r.value === true
  ).length;
  if (released > 0) {
    notifyTasksUpdated(teamName);
  }
  return released;
}
__name(unassignTeammateTasks, "unassignTeammateTasks");
async function getNextTaskId(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return "1";
  }
  let maxId = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const num = parseInt(entry.replace(".json", ""), 10);
    if (!isNaN(num) && num > maxId) {
      maxId = num;
    }
  }
  return String(maxId + 1);
}
__name(getNextTaskId, "getNextTaskId");

export {
  RECIPROCAL_CALLER,
  assertValidTaskId,
  normalizeTaskId,
  onTasksUpdated,
  createTask,
  getTask,
  TaskOwnershipError,
  TaskSnapshotChangedError,
  updateTask,
  deleteTask,
  listTasks,
  resetTaskList,
  claimTask,
  unassignTeammateTasks
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
