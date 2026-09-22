// Force strict mode and setup for ESM
"use strict";
import {
  Mutex
} from "./chunk-VGC4I5JJ.js";
import {
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  Storage,
  getProjectHash
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/cronTasksFile.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
import * as path from "node:path";
var MAX_CRON_TASK_ROUTING_ID_LENGTH = 256;
function isValidCronTaskRoutingId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CRON_TASK_ROUTING_ID_LENGTH && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
__name(isValidCronTaskRoutingId, "isValidCronTaskRoutingId");
var MAX_TASK_RUNS = 20;
var MAX_CHANNEL_DELIVERY_NAME_LENGTH = 2048;
var MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH = 2048;
function annotateCronRunSession(task, firedAt, outcome) {
  const index = task.runs?.findIndex((run2) => run2.at === firedAt) ?? -1;
  if (index < 0 || !task.runs) return task;
  const run = { ...task.runs[index] };
  delete run.sessionId;
  delete run.sessionDispatchFailed;
  if (outcome.sessionId) run.sessionId = outcome.sessionId;
  if (outcome.dispatchFailed) run.sessionDispatchFailed = true;
  const runs = [...task.runs];
  runs[index] = run;
  return { ...task, runs };
}
__name(annotateCronRunSession, "annotateCronRunSession");
function appendCronRun(runs, entry) {
  const base = Array.isArray(runs) ? runs : [];
  const next = [...base, entry];
  return next.length > MAX_TASK_RUNS ? next.slice(next.length - MAX_TASK_RUNS) : next;
}
__name(appendCronRun, "appendCronRun");
function taskHasLegacyCondition(task) {
  const condition = task["condition"];
  return typeof condition === "string" && condition.length > 0;
}
__name(taskHasLegacyCondition, "taskHasLegacyCondition");
function taskHasLegacyRunMode(task) {
  return task["runMode"] === "isolated";
}
__name(taskHasLegacyRunMode, "taskHasLegacyRunMode");
function generateCronTaskId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
__name(generateCronTaskId, "generateCronTaskId");
var TASKS_FILENAME = "scheduled_tasks.json";
var CRON_TASKS_DISPLAY_PATH = `~/.qwen/tmp/<project-hash>/${TASKS_FILENAME}`;
var UPDATE_LOCK_RETRY_MS = 15;
var UPDATE_LOCK_STALE_MS = 2e3;
var UPDATE_LOCK_TIMEOUT_MS = 3e3;
var updateStaleSeq = 0;
var updateMutexes = /* @__PURE__ */ new Map();
var MAX_TASK_DELETION_GENERATIONS = 1e4;
function getUpdateMutex(filePath) {
  let mutex = updateMutexes.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    updateMutexes.set(filePath, mutex);
  }
  return mutex;
}
__name(getUpdateMutex, "getUpdateMutex");
async function readTaskDeletionGenerations(filePath) {
  const statePath = `${filePath}.deletions`;
  let raw;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { generations: /* @__PURE__ */ new Map(), watermark: 0 };
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (parsed.version !== 2 || !Number.isSafeInteger(parsed.watermark) || parsed.watermark < 0 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid scheduled-task deletion state: ${statePath}`);
  }
  const generations = /* @__PURE__ */ new Map();
  let maximumGeneration = 0;
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !Number.isSafeInteger(entry[1]) || entry[1] < 1 || generations.has(entry[0])) {
      throw new Error(`Invalid scheduled-task deletion state: ${statePath}`);
    }
    generations.set(entry[0], entry[1]);
    maximumGeneration = Math.max(maximumGeneration, entry[1]);
  }
  const watermark = parsed.watermark;
  if (watermark < maximumGeneration) {
    throw new Error(`Invalid scheduled-task deletion state: ${statePath}`);
  }
  return { generations, watermark };
}
__name(readTaskDeletionGenerations, "readTaskDeletionGenerations");
async function readTaskDeletionGenerationsOrUnknown(filePath) {
  try {
    return await readTaskDeletionGenerations(filePath);
  } catch (error) {
    console.warn(
      `Ignoring unreadable scheduled-task deletion state at ${filePath}.deletions (${error instanceof Error ? error.message : String(error)}) \u2014 task updates proceed without it; delete the file to rebuild it.`
    );
    return void 0;
  }
}
__name(readTaskDeletionGenerationsOrUnknown, "readTaskDeletionGenerationsOrUnknown");
async function writeTaskDeletionGenerations(filePath, deletionState, assertCanCommit) {
  const state = {
    version: 2,
    watermark: deletionState.watermark,
    entries: [...deletionState.generations]
  };
  await atomicWriteJSON(`${filePath}.deletions`, state, {
    noFollow: true,
    assertCanCommit
  });
}
__name(writeTaskDeletionGenerations, "writeTaskDeletionGenerations");
function getCronFilePath(projectRoot) {
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    TASKS_FILENAME
  );
}
__name(getCronFilePath, "getCronFilePath");
async function readCronTasks(projectRoot) {
  const filePath = getCronFilePath(projectRoot);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} \u2014 fix or delete the file; refusing to treat it as an empty schedule.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array in ${filePath} \u2014 fix or delete the file; refusing to treat it as an empty schedule.`
    );
  }
  const normalized = parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const record = entry;
    if ((record["modelServiceId"] !== void 0 || record["groupId"] !== void 0) && record["sessionMode"] !== "per_run") {
      const copy = { ...record };
      delete copy["modelServiceId"];
      delete copy["groupId"];
      return copy;
    }
    return entry;
  });
  for (const [index, task] of normalized.entries()) {
    if (!isValidTask(task)) {
      throw new Error(
        `Invalid task entry at index ${index} in ${filePath} \u2014 fix or delete the entry; refusing to drop it from the schedule.`
      );
    }
  }
  return normalized;
}
__name(readCronTasks, "readCronTasks");
async function writeCronTasks(projectRoot, tasks, options = {}) {
  const filePath = getCronFilePath(projectRoot);
  options.assertCanCommit?.();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, tasks, {
    noFollow: true,
    assertCanCommit: options.assertCanCommit
  });
}
__name(writeCronTasks, "writeCronTasks");
async function acquireUpdateLock(filePath) {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + UPDATE_LOCK_TIMEOUT_MS;
  for (; ; ) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for scheduled-tasks lock (${lockPath})`
      );
    }
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: "wx" });
      return async () => {
        await fs.unlink(lockPath).catch(() => {
        });
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    try {
      const stat2 = await fs.stat(lockPath);
      if (Date.now() - stat2.mtimeMs > UPDATE_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale.${process.pid}.${updateStaleSeq++}`;
        try {
          await fs.rename(lockPath, stalePath);
        } catch {
          continue;
        }
        const moved = await fs.stat(stalePath).catch(() => null);
        if (moved && Date.now() - moved.mtimeMs <= UPDATE_LOCK_STALE_MS) {
          await fs.link(stalePath, lockPath).catch(() => {
          });
        }
        await fs.unlink(stalePath).catch(() => {
        });
        continue;
      }
    } catch {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, UPDATE_LOCK_RETRY_MS));
  }
}
__name(acquireUpdateLock, "acquireUpdateLock");
function cronTaskSessionDeletionId(sessionId) {
  const canonicalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    sessionId
  ) ? sessionId.toLowerCase() : sessionId;
  return `session:${canonicalId}`;
}
__name(cronTaskSessionDeletionId, "cronTaskSessionDeletionId");
async function updateCronTasks(projectRoot, mutate, options = {}) {
  const filePath = getCronFilePath(projectRoot);
  return getUpdateMutex(filePath).runExclusive(async () => {
    const release = await acquireUpdateLock(filePath);
    try {
      const tasks = await readCronTasks(projectRoot);
      const observedIds = new Set(
        typeof options.observeDeletionIds === "function" ? options.observeDeletionIds(tasks) : options.observeDeletionIds ?? []
      );
      let deletionState;
      let deletionStateUnknown = false;
      const loadDeletionState = /* @__PURE__ */ __name(async () => {
        if (deletionState === void 0 && !deletionStateUnknown) {
          const state = await readTaskDeletionGenerationsOrUnknown(filePath);
          if (state === void 0) {
            deletionStateUnknown = true;
          } else {
            deletionState = state;
          }
        }
        return deletionState;
      }, "loadDeletionState");
      if (observedIds.size > 0) {
        const observedDeletionState = await loadDeletionState();
        if (observedDeletionState !== void 0) {
          options.onDeletionGenerations?.(
            new Map(
              [...observedIds].map((id) => [
                id,
                observedDeletionState.generations.get(id) ?? 0
              ])
            )
          );
        }
      }
      const next = mutate(tasks);
      const deletionIds = typeof options.deletionIds === "function" ? options.deletionIds() : options.deletionIds;
      if (deletionIds?.length) {
        deletionState = await loadDeletionState() ?? {
          generations: /* @__PURE__ */ new Map(),
          watermark: 0
        };
        for (const id of new Set(deletionIds)) {
          if (deletionState.watermark === Number.MAX_SAFE_INTEGER) {
            throw new Error(
              `Scheduled-task deletion generation overflow for ${id}`
            );
          }
          deletionState.watermark += 1;
          deletionState.generations.delete(id);
          deletionState.generations.set(id, deletionState.watermark);
        }
        while (deletionState.generations.size > MAX_TASK_DELETION_GENERATIONS) {
          const oldest = deletionState.generations.keys().next().value;
          if (oldest === void 0) break;
          deletionState.generations.delete(oldest);
        }
        await writeTaskDeletionGenerations(
          filePath,
          deletionState,
          options.assertCanCommit
        );
      }
      if (next !== tasks) {
        await writeCronTasks(projectRoot, next, options);
      }
    } finally {
      await release();
    }
  });
}
__name(updateCronTasks, "updateCronTasks");
async function addCronTask(projectRoot, task) {
  await updateCronTasks(projectRoot, (tasks) => [...tasks, task]);
}
__name(addCronTask, "addCronTask");
async function removeCronTasks(projectRoot, ids) {
  const idSet = new Set(ids);
  try {
    await fs.access(getCronFilePath(projectRoot));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  await updateCronTasks(
    projectRoot,
    (tasks) => {
      const remaining = tasks.filter((t) => !idSet.has(t.id));
      removed = tasks.length - remaining.length;
      return removed === 0 ? tasks : remaining;
    },
    { deletionIds: ids }
  );
  return removed;
}
__name(removeCronTasks, "removeCronTasks");
function isFiniteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}
__name(isFiniteTimestamp, "isFiniteTimestamp");
function isValidRuns(value) {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const run = entry;
    return isFiniteTimestamp(run["at"]) && (run["kind"] === void 0 || typeof run["kind"] === "string") && (run["sessionId"] === void 0 || typeof run["sessionId"] === "string") && (run["sessionDispatchFailed"] === void 0 || typeof run["sessionDispatchFailed"] === "boolean") && // Read-only legacy compat: validate so a stored `withheld` marker isn't
    // rejected on read (it is never written anymore).
    (run["withheld"] === void 0 || typeof run["withheld"] === "boolean");
  });
}
__name(isValidRuns, "isValidRuns");
function isValidDelivery(value) {
  if (typeof value !== "object" || value === null) return false;
  const delivery = value;
  const rawTarget = delivery["target"];
  if (delivery["kind"] !== "channel" || typeof rawTarget !== "object" || rawTarget === null || !Object.keys(delivery).every((key) => key === "kind" || key === "target")) {
    return false;
  }
  const target = rawTarget;
  return typeof target["channelName"] === "string" && target["channelName"].trim().length > 0 && target["channelName"].length <= MAX_CHANNEL_DELIVERY_NAME_LENGTH && (target["type"] === "user" || target["type"] === "chat") && typeof target["id"] === "string" && target["id"].trim().length > 0 && target["id"].length <= MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH && Object.keys(target).every(
    (key) => key === "channelName" || key === "type" || key === "id"
  );
}
__name(isValidDelivery, "isValidDelivery");
function isValidTask(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  return typeof obj["id"] === "string" && typeof obj["cron"] === "string" && typeof obj["prompt"] === "string" && typeof obj["recurring"] === "boolean" && isFiniteTimestamp(obj["createdAt"]) && (obj["lastFiredAt"] === null || isFiniteTimestamp(obj["lastFiredAt"])) && // Optional fields (added for the management UI): absent is valid and
  // means "unnamed" / "enabled". Present-but-wrong-type routes through
  // the same fix-or-delete contract as any other corrupt field rather
  // than being silently coerced or dropped.
  (obj["name"] === void 0 || typeof obj["name"] === "string") && (obj["enabled"] === void 0 || typeof obj["enabled"] === "boolean") && (obj["disabledByArchive"] === void 0 || typeof obj["disabledByArchive"] === "boolean") && // A bound sessionId must be a NON-EMPTY string: an empty string would pass
  // a bare `typeof` check but the scheduler's truthy `task.sessionId` guard
  // would treat it as unbound, so a "bound" task would silently run unbound.
  (obj["sessionId"] === void 0 || typeof obj["sessionId"] === "string" && obj["sessionId"].length > 0) && (obj["sessionOwnedByTask"] === void 0 || typeof obj["sessionOwnedByTask"] === "boolean") && (obj["sessionMode"] === void 0 || obj["sessionMode"] === "persistent" || obj["sessionMode"] === "per_run") && (obj["modelServiceId"] === void 0 || isValidCronTaskRoutingId(obj["modelServiceId"])) && (obj["groupId"] === void 0 || isValidCronTaskRoutingId(obj["groupId"])) && (obj["delivery"] === void 0 || isValidDelivery(obj["delivery"])) && (obj["runs"] === void 0 || isValidRuns(obj["runs"]));
}
__name(isValidTask, "isValidTask");

export {
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  isValidCronTaskRoutingId,
  MAX_CHANNEL_DELIVERY_NAME_LENGTH,
  MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH,
  annotateCronRunSession,
  appendCronRun,
  taskHasLegacyCondition,
  taskHasLegacyRunMode,
  generateCronTaskId,
  CRON_TASKS_DISPLAY_PATH,
  getCronFilePath,
  readCronTasks,
  cronTaskSessionDeletionId,
  updateCronTasks,
  addCronTask,
  removeCronTasks
};
