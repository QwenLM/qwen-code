// Force strict mode and setup for ESM
"use strict";
import {
  msSinceLastInteraction
} from "./chunk-KW7NOTN6.js";
import {
  DEFAULT_OPENAI_LOG_RETENTION_DAYS
} from "./chunk-EP6WO7OX.js";
import {
  resolveOpenAILogDir
} from "./chunk-PU756QJZ.js";
import {
  FILE_HISTORY_DIR,
  getSubagentsRootDir
} from "./chunk-MRTRBONQ.js";
import {
  Storage,
  createDebugLogger,
  sessionIdContext
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/services/housekeeping/scheduler.ts
init_esbuild_shims();
import { stat as stat3 } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join as join2 } from "node:path";

// packages/cli/src/utils/housekeeping/cleanup.ts
init_esbuild_shims();
import { opendir, readdir, stat, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
var debugLogger = createDebugLogger("HOUSEKEEPING");
var MS_PER_DAY = 24 * 60 * 60 * 1e3;
var MS_PER_HOUR = 60 * 60 * 1e3;
var MIN_DATE_MS = -864e13;
var SWEEP_CONCURRENCY = 20;
function getCutoffDate(cleanupPeriodDays) {
  const periodMs = cleanupPeriodDays > 0 ? cleanupPeriodDays * MS_PER_DAY : MS_PER_HOUR;
  return new Date(Math.max(Date.now() - periodMs, MIN_DATE_MS));
}
__name(getCutoffDate, "getCutoffDate");
async function sweepOldSessionDirs(root, opts) {
  const result = { removed: 0, errors: 0 };
  const excludes = opts.excludeSessionIds ?? /* @__PURE__ */ new Set();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error("readdir failed", e);
    return result;
  }
  const sessionDirs = entries.filter((e) => e.isDirectory() && !excludes.has(e.name)).map((e) => join(root, e.name));
  for (let i = 0; i < sessionDirs.length; i += SWEEP_CONCURRENCY) {
    const batch = sessionDirs.slice(i, i + SWEEP_CONCURRENCY);
    await Promise.all(
      batch.map(async (dir) => {
        try {
          const s = await stat(dir);
          if (s.mtime < opts.cutoffDate) {
            await rm(dir, { recursive: true, force: true });
            result.removed++;
          }
        } catch (err) {
          result.errors++;
          debugLogger.error(`failed to sweep ${dir}`, err);
        }
      })
    );
  }
  if (opts.removeEmptyRoot !== false) {
    await rmdir(root).catch(() => {
    });
  }
  return result;
}
__name(sweepOldSessionDirs, "sweepOldSessionDirs");
async function cleanupOldFileHistoryBackups(opts) {
  return sweepOldSessionDirs(
    join(Storage.getGlobalQwenDir(), FILE_HISTORY_DIR),
    opts
  );
}
__name(cleanupOldFileHistoryBackups, "cleanupOldFileHistoryBackups");
async function cleanupOldSubagentTranscripts(opts) {
  return sweepOldSessionDirs(opts.subagentsRoot, {
    ...opts,
    removeEmptyRoot: false
  });
}
__name(cleanupOldSubagentTranscripts, "cleanupOldSubagentTranscripts");
var OPENAI_LOG_FILE_PATTERN = /^openai-(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}(?:-[a-zA-Z0-9._](?:[a-zA-Z0-9._-]*[a-zA-Z0-9._])?)?\.json$/;
async function cleanupOldOpenAILogs(opts) {
  const result = {
    removed: 0,
    errors: 0,
    completed: true
  };
  if (opts.signal?.aborted) {
    result.completed = false;
    return result;
  }
  let dir;
  try {
    dir = await opendir(opts.logDir);
  } catch (e) {
    if (isENOENT(e)) return result;
    debugLogger.error("opendir failed", e);
    throw e;
  }
  const cutoffDay = opts.cutoffDate.toISOString().slice(0, 10);
  let batch = [];
  for await (const entry of dir) {
    if (opts.signal?.aborted) {
      result.completed = false;
      break;
    }
    const filenameDate = entry.isFile() ? OPENAI_LOG_FILE_PATTERN.exec(entry.name)?.[1] : void 0;
    if (!filenameDate) continue;
    const filePath = join(opts.logDir, entry.name);
    batch.push(
      (async () => {
        try {
          let shouldRemove;
          if (filenameDate !== cutoffDay) {
            shouldRemove = filenameDate < cutoffDay;
          } else {
            const s = await stat(filePath);
            shouldRemove = s.mtime < opts.cutoffDate;
          }
          if (shouldRemove) {
            await unlink(filePath);
            result.removed++;
          }
        } catch (err) {
          if (isENOENT(err)) return;
          result.errors++;
          debugLogger.error(`failed to sweep ${filePath}`, err);
        }
      })()
    );
    if (batch.length === SWEEP_CONCURRENCY) {
      await Promise.all(batch);
      batch = [];
    }
  }
  await Promise.all(batch);
  return result;
}
__name(cleanupOldOpenAILogs, "cleanupOldOpenAILogs");
function isENOENT(e) {
  return e?.code === "ENOENT";
}
__name(isENOENT, "isENOENT");

// packages/cli/src/utils/housekeeping/throttledOnce.ts
init_esbuild_shims();
import { mkdir, open, stat as stat2, unlink as unlink2, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var debugLogger2 = createDebugLogger("HOUSEKEEPING");
var ONE_DAY_MS = 24 * 60 * 60 * 1e3;
var STALE_LOCK_MS = 60 * 60 * 1e3;
async function runThrottledOnce(opts, task) {
  const minIntervalMs = opts.minIntervalMs ?? ONE_DAY_MS;
  const staleLockMs = opts.staleLockMs ?? STALE_LOCK_MS;
  await mkdir(dirname(opts.lockPath), { mode: 448 }).catch(() => {
  });
  const firstFreshForMs = await markerFreshForMs(
    opts.markerPath,
    minIntervalMs,
    opts.name
  );
  if (firstFreshForMs !== void 0) {
    return { status: "fresh", retryAfterMs: firstFreshForMs };
  }
  let acquired = await tryAcquire(opts.lockPath);
  if (!acquired) {
    try {
      const s = await stat2(opts.lockPath);
      if (Date.now() - s.mtimeMs > staleLockMs) {
        await unlink2(opts.lockPath).catch(() => {
        });
        acquired = await tryAcquire(opts.lockPath);
      }
    } catch {
      acquired = await tryAcquire(opts.lockPath);
    }
    if (!acquired) {
      debugLogger2.debug(`${opts.name}: skipping, lock held`);
      return { status: "locked" };
    }
  }
  try {
    const secondFreshForMs = await markerFreshForMs(
      opts.markerPath,
      minIntervalMs,
      opts.name
    );
    if (secondFreshForMs !== void 0) {
      return { status: "fresh", retryAfterMs: secondFreshForMs };
    }
    let taskCompleted = false;
    try {
      taskCompleted = await task() !== false;
    } finally {
      if (taskCompleted) {
        try {
          await writeFile(opts.markerPath, (/* @__PURE__ */ new Date()).toISOString());
        } catch (err) {
          debugLogger2.debug(
            `${opts.name}: marker write failed (cleanup succeeded)`,
            err
          );
        }
      }
    }
    return { status: taskCompleted ? "completed" : "incomplete" };
  } finally {
    await unlink2(opts.lockPath).catch(() => {
      debugLogger2.debug(`${opts.name}: lock unlink failed (harmless)`);
    });
  }
}
__name(runThrottledOnce, "runThrottledOnce");
async function markerFreshForMs(markerPath, minIntervalMs, name) {
  try {
    const s = await stat2(markerPath);
    const age = Date.now() - s.mtimeMs;
    if (age < minIntervalMs) {
      debugLogger2.debug(`${name}: skipping, ran ${age}ms ago`);
      return minIntervalMs - age;
    }
  } catch {
  }
  return void 0;
}
__name(markerFreshForMs, "markerFreshForMs");
async function tryAcquire(lockPath) {
  try {
    const fh = await open(lockPath, "wx");
    await fh.close();
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") {
      return false;
    }
    throw e;
  }
}
__name(tryAcquire, "tryAcquire");

// packages/cli/src/services/housekeeping/scheduler.ts
var debugLogger3 = createDebugLogger("HOUSEKEEPING");
var STARTUP_DELAY_MS = 10 * 60 * 1e3;
var RECURRING_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var RECENT_INTERACTION_MS = 60 * 1e3;
var CATCHUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1e3;
var STARTUP_DELAY_CATCHUP_MS = 60 * 1e3;
var NON_INTERACTIVE_LOCK_RETRY_MS = 60 * 1e3;
var NON_INTERACTIVE_FAILURE_RETRY_MS = 10 * 60 * 1e3;
var NON_INTERACTIVE_STOP_GRACE_MS = 250;
var FILE_HISTORY_MARKER = ".file-history-cleanup";
var SUBAGENT_MARKER = ".subagent-cleanup";
var OPENAI_LOGS_MARKER = ".openai-logs-cleanup";
var started = false;
var nonInteractiveJobs = /* @__PURE__ */ new Map();
var nonInteractiveQueue = [];
var activeNonInteractiveJob;
var activeNonInteractiveAbortController;
var nonInteractiveWorker;
var nonInteractiveStopping = false;
var nonInteractiveStopPromise;
function startBackgroundHousekeeping(config, settings) {
  if (started) return;
  started = true;
  void scheduleFirstPass(config, settings).catch((err) => {
    started = false;
    debugLogger3.error(
      "scheduleFirstPass failed; chain will retry on next start",
      err
    );
  });
}
__name(startBackgroundHousekeeping, "startBackgroundHousekeeping");
async function scheduleFirstPass(config, settings) {
  const delay = await getFirstPassDelay(config, settings);
  debugLogger3.debug(`first pass in ${delay / 1e3}s`);
  setTimeout(() => scheduleNextPass(config, settings), delay).unref();
}
__name(scheduleFirstPass, "scheduleFirstPass");
async function getFirstPassDelay(config, settings) {
  const qwenDir = Storage.getGlobalQwenDir();
  const markerPaths = [join2(qwenDir, FILE_HISTORY_MARKER)];
  const openaiTarget = getOpenAILogCleanupTarget(config, settings);
  if (openaiTarget) {
    markerPaths.push(getOpenAILogsMarkerPath(qwenDir, openaiTarget.logDir));
  }
  const catchUpStates = await Promise.all(markerPaths.map(needsCatchUp));
  return catchUpStates.some(Boolean) ? STARTUP_DELAY_CATCHUP_MS : STARTUP_DELAY_MS;
}
__name(getFirstPassDelay, "getFirstPassDelay");
async function needsCatchUp(markerPath) {
  try {
    const s = await stat3(markerPath);
    return Date.now() - s.mtimeMs > CATCHUP_THRESHOLD_MS;
  } catch {
    return true;
  }
}
__name(needsCatchUp, "needsCatchUp");
function getSubagentMarkerPath(qwenDir, projectDir) {
  const projectKey = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  return join2(qwenDir, `${SUBAGENT_MARKER}-${projectKey}`);
}
__name(getSubagentMarkerPath, "getSubagentMarkerPath");
function getOpenAILogsMarkerPath(qwenDir, logDir) {
  const logDirKey = createHash("sha256").update(logDir).digest("hex").slice(0, 16);
  return join2(qwenDir, `${OPENAI_LOGS_MARKER}-${logDirKey}`);
}
__name(getOpenAILogsMarkerPath, "getOpenAILogsMarkerPath");
function getOpenAILogCleanupTarget(config, settings) {
  try {
    const customLogDir = config.getContentGeneratorConfig?.()?.openAILoggingDir ?? config.getModelsConfig?.()?.getGenerationConfig?.().openAILoggingDir ?? settings.merged.model?.openAILoggingDir;
    const systemRetention = settings.system?.settings.model?.openAILogRetentionDays;
    const workspaceRetention = settings.isTrusted ? settings.workspace?.settings.model?.openAILogRetentionDays : void 0;
    if (customLogDir && workspaceRetention !== void 0 && systemRetention === void 0) {
      debugLogger3.error(
        "workspace-scoped openAILogRetentionDays is unsafe with a custom openAILoggingDir; skipping cleanup"
      );
      return void 0;
    }
    const retentionDays = customLogDir ? systemRetention ?? settings.user?.settings.model?.openAILogRetentionDays ?? settings.systemDefaults?.settings.model?.openAILogRetentionDays ?? DEFAULT_OPENAI_LOG_RETENTION_DAYS : settings.merged.model?.openAILogRetentionDays ?? DEFAULT_OPENAI_LOG_RETENTION_DAYS;
    return {
      logDir: resolveOpenAILogDir(customLogDir, config.getWorkingDir()),
      retentionDays
    };
  } catch (err) {
    debugLogger3.error(
      "failed to resolve OpenAI log cleanup target; skipping",
      err
    );
    return void 0;
  }
}
__name(getOpenAILogCleanupTarget, "getOpenAILogCleanupTarget");
function startNonInteractiveOpenAILogHousekeeping(config, settings) {
  if (nonInteractiveStopping) return;
  sessionIdContext.exit(() => {
    try {
      const target = getOpenAILogCleanupTarget(config, settings);
      if (!target || nonInteractiveJobs.has(target.logDir)) return;
      const markerPath = getOpenAILogsMarkerPath(
        Storage.getGlobalQwenDir(),
        target.logDir
      );
      const job = {
        target,
        markerPath,
        queued: false
      };
      nonInteractiveJobs.set(target.logDir, job);
      enqueueNonInteractiveJob(job);
    } catch (err) {
      debugLogger3.error(
        "failed to start non-interactive OpenAI log cleanup; skipping",
        err
      );
    }
  });
}
__name(startNonInteractiveOpenAILogHousekeeping, "startNonInteractiveOpenAILogHousekeeping");
function stopNonInteractiveOpenAILogHousekeeping() {
  if (nonInteractiveStopPromise) return nonInteractiveStopPromise;
  nonInteractiveStopping = true;
  for (const job of nonInteractiveJobs.values()) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = void 0;
    }
    job.queued = false;
  }
  nonInteractiveQueue.length = 0;
  activeNonInteractiveAbortController?.abort();
  nonInteractiveStopPromise = waitForNonInteractiveWorkerToStop();
  return nonInteractiveStopPromise;
}
__name(stopNonInteractiveOpenAILogHousekeeping, "stopNonInteractiveOpenAILogHousekeeping");
function enqueueNonInteractiveJob(job) {
  if (nonInteractiveStopping || job.queued || activeNonInteractiveJob === job) {
    return;
  }
  job.queued = true;
  nonInteractiveQueue.push(job);
  startNonInteractiveWorker();
}
__name(enqueueNonInteractiveJob, "enqueueNonInteractiveJob");
function startNonInteractiveWorker() {
  if (nonInteractiveWorker || nonInteractiveStopping) return;
  nonInteractiveWorker = drainNonInteractiveQueue().catch((err) => {
    debugLogger3.error("non-interactive OpenAI log worker failed", err);
  }).finally(() => {
    nonInteractiveWorker = void 0;
    if (nonInteractiveQueue.length > 0 && !nonInteractiveStopping) {
      startNonInteractiveWorker();
    }
  });
}
__name(startNonInteractiveWorker, "startNonInteractiveWorker");
async function drainNonInteractiveQueue() {
  while (!nonInteractiveStopping) {
    const job = nonInteractiveQueue.shift();
    if (!job) return;
    job.queued = false;
    activeNonInteractiveJob = job;
    const abortController = new AbortController();
    activeNonInteractiveAbortController = abortController;
    try {
      const result = await runOpenAILogCleanup(
        job.target,
        job.markerPath,
        abortController.signal
      );
      if (nonInteractiveStopping) continue;
      switch (result.status) {
        case "completed":
          scheduleNonInteractiveJob(job, RECURRING_INTERVAL_MS);
          break;
        case "fresh":
          scheduleNonInteractiveJob(
            job,
            Math.min(
              RECURRING_INTERVAL_MS,
              Math.max(NON_INTERACTIVE_LOCK_RETRY_MS, result.retryAfterMs)
            )
          );
          break;
        case "locked":
          scheduleNonInteractiveJob(job, NON_INTERACTIVE_LOCK_RETRY_MS);
          break;
        case "incomplete":
          break;
        default:
          break;
      }
    } catch (err) {
      debugLogger3.error(
        `non-interactive OpenAI log cleanup failed for ${job.target.logDir}`,
        err
      );
      if (!nonInteractiveStopping) {
        scheduleNonInteractiveJob(job, NON_INTERACTIVE_FAILURE_RETRY_MS);
      }
    } finally {
      activeNonInteractiveJob = void 0;
      activeNonInteractiveAbortController = void 0;
    }
  }
}
__name(drainNonInteractiveQueue, "drainNonInteractiveQueue");
async function runOpenAILogCleanup(target, markerPath, signal) {
  return runThrottledOnce(
    {
      name: "openai-logs-cleanup",
      markerPath,
      lockPath: markerPath + ".lock"
    },
    async () => {
      const r = await cleanupOldOpenAILogs({
        logDir: target.logDir,
        cutoffDate: getCutoffDate(target.retentionDays),
        signal
      });
      debugLogger3.debug(
        `openai-logs: removed=${r.removed} errors=${r.errors} completed=${r.completed}`
      );
      return r.completed ? void 0 : false;
    }
  );
}
__name(runOpenAILogCleanup, "runOpenAILogCleanup");
function scheduleNonInteractiveJob(job, delayMs) {
  if (nonInteractiveStopping) return;
  job.timer = setTimeout(() => {
    job.timer = void 0;
    enqueueNonInteractiveJob(job);
  }, delayMs);
  job.timer.unref();
}
__name(scheduleNonInteractiveJob, "scheduleNonInteractiveJob");
async function waitForNonInteractiveWorkerToStop() {
  const worker = nonInteractiveWorker;
  if (!worker) {
    nonInteractiveJobs.clear();
    return;
  }
  let timeout;
  try {
    await Promise.race([
      worker,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, NON_INTERACTIVE_STOP_GRACE_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    nonInteractiveJobs.clear();
  }
}
__name(waitForNonInteractiveWorkerToStop, "waitForNonInteractiveWorkerToStop");
async function runPass(config, settings) {
  if (msSinceLastInteraction() < RECENT_INTERACTION_MS) {
    debugLogger3.debug("user active, deferring 10 min");
    setTimeout(
      () => scheduleNextPass(config, settings),
      STARTUP_DELAY_MS
    ).unref();
    return;
  }
  try {
    await runHousekeeping(config, settings);
  } catch (err) {
    debugLogger3.error("housekeeping pass failed; will retry next cycle", err);
  }
  setTimeout(
    () => scheduleNextPass(config, settings),
    RECURRING_INTERVAL_MS
  ).unref();
}
__name(runPass, "runPass");
function scheduleNextPass(config, settings) {
  void runPass(config, settings).catch((err) => {
    debugLogger3.error("runPass rejected unexpectedly", err);
  });
}
__name(scheduleNextPass, "scheduleNextPass");
async function runHousekeeping(config, settings) {
  const days = settings.merged.general?.cleanupPeriodDays ?? 30;
  const cutoff = getCutoffDate(days);
  const currentSessionId = config.getSessionId();
  const qwenDir = Storage.getGlobalQwenDir();
  await runThrottledOnce(
    {
      name: "file-history-cleanup",
      markerPath: join2(qwenDir, FILE_HISTORY_MARKER),
      lockPath: join2(qwenDir, FILE_HISTORY_MARKER + ".lock")
    },
    async () => {
      const r = await cleanupOldFileHistoryBackups({
        cutoffDate: cutoff,
        excludeSessionIds: /* @__PURE__ */ new Set([currentSessionId])
      });
      debugLogger3.debug(
        `file-history: removed=${r.removed} errors=${r.errors}`
      );
    }
  );
  const projectDir = config.storage?.getProjectDir?.();
  if (projectDir) {
    const markerPath = getSubagentMarkerPath(qwenDir, projectDir);
    await runThrottledOnce(
      {
        name: "subagent-cleanup",
        markerPath,
        lockPath: markerPath + ".lock"
      },
      async () => {
        const r = await cleanupOldSubagentTranscripts({
          cutoffDate: cutoff,
          excludeSessionIds: /* @__PURE__ */ new Set([currentSessionId]),
          subagentsRoot: getSubagentsRootDir(projectDir)
        });
        debugLogger3.debug(`subagents: removed=${r.removed} errors=${r.errors}`);
      }
    );
  }
  const openaiTarget = getOpenAILogCleanupTarget(config, settings);
  if (openaiTarget) {
    await runOpenAILogCleanup(
      openaiTarget,
      getOpenAILogsMarkerPath(qwenDir, openaiTarget.logDir)
    );
  }
}
__name(runHousekeeping, "runHousekeeping");
function _resetForTesting() {
  started = false;
}
__name(_resetForTesting, "_resetForTesting");
async function _resetNonInteractiveForTesting() {
  nonInteractiveStopping = true;
  for (const job of nonInteractiveJobs.values()) {
    if (job.timer) clearTimeout(job.timer);
  }
  nonInteractiveQueue.length = 0;
  activeNonInteractiveAbortController?.abort();
  await nonInteractiveWorker;
  nonInteractiveJobs.clear();
  activeNonInteractiveJob = void 0;
  activeNonInteractiveAbortController = void 0;
  nonInteractiveWorker = void 0;
  nonInteractiveStopping = false;
  nonInteractiveStopPromise = void 0;
}
__name(_resetNonInteractiveForTesting, "_resetNonInteractiveForTesting");
var _needsCatchUpForTesting = needsCatchUp;
var _getFirstPassDelayForTesting = getFirstPassDelay;
var _runHousekeepingForTesting = runHousekeeping;
var _runPassForTesting = runPass;
var _FILE_HISTORY_MARKER_FOR_TESTING = FILE_HISTORY_MARKER;
var _getSubagentMarkerPathForTesting = getSubagentMarkerPath;
var _getOpenAILogsMarkerPathForTesting = getOpenAILogsMarkerPath;

export {
  startBackgroundHousekeeping,
  startNonInteractiveOpenAILogHousekeeping,
  stopNonInteractiveOpenAILogHousekeeping,
  _resetForTesting,
  _resetNonInteractiveForTesting,
  _needsCatchUpForTesting,
  _getFirstPassDelayForTesting,
  _runHousekeepingForTesting,
  _runPassForTesting,
  _FILE_HISTORY_MARKER_FOR_TESTING,
  _getSubagentMarkerPathForTesting,
  _getOpenAILogsMarkerPathForTesting
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
