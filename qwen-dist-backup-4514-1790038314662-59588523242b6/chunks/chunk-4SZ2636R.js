// Force strict mode and setup for ESM
"use strict";
import {
  matches,
  nextFireTime,
  parseCron
} from "./chunk-5EZRLTLQ.js";
import {
  humanReadableCron
} from "./chunk-QHWCP53L.js";
import {
  CRON_TASKS_DISPLAY_PATH,
  addCronTask,
  annotateCronRunSession,
  appendCronRun,
  cronTaskSessionDeletionId,
  generateCronTaskId,
  getCronFilePath,
  readCronTasks,
  removeCronTasks,
  taskHasLegacyCondition,
  taskHasLegacyRunMode,
  updateCronTasks
} from "./chunk-C4FISGDN.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger,
  getProjectHash
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/file-watcher-cleanup.ts
init_esbuild_shims();
var exitingProcess = false;
function prepareFileWatchersForProcessExit() {
  exitingProcess = process.platform === "darwin";
}
__name(prepareFileWatchersForProcessExit, "prepareFileWatchersForProcessExit");
function closeFileWatcher(watcher) {
  if (!watcher) return Promise.resolve();
  if (exitingProcess) {
    watcher.removeAllListeners("all");
    watcher.removeAllListeners("change");
    return Promise.resolve();
  }
  return Promise.resolve(watcher.close());
}
__name(closeFileWatcher, "closeFileWatcher");

// packages/core/src/services/cronScheduler.ts
init_esbuild_shims();
import * as fsSync from "node:fs";
import * as path2 from "node:path";

// packages/core/src/services/cronTasksLock.ts
init_esbuild_shims();
import * as fs from "node:fs/promises";
import * as path from "node:path";
var LOCK_FILENAME = "scheduled_tasks.lock";
var staleSeq = 0;
function getLockFilePath(projectRoot) {
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    LOCK_FILENAME
  );
}
__name(getLockFilePath, "getLockFilePath");
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
__name(isProcessAlive, "isProcessAlive");
async function tryAcquireLock(projectRoot, sessionId, lockId) {
  const lockPath = getLockFilePath(projectRoot);
  const content = { pid: process.pid, sessionId, lockId };
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(content), {
        encoding: "utf-8",
        flag: "wx"
      });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let existing = null;
    try {
      existing = JSON.parse(await fs.readFile(lockPath, "utf-8"));
    } catch (err) {
      if (err.code === "ENOENT") {
        continue;
      }
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
    }
    if (existing) {
      if (existing.pid === process.pid && existing.sessionId === sessionId && existing.lockId === lockId) {
        return true;
      }
      if (isProcessAlive(existing.pid)) {
        return false;
      }
    }
    const stalePath = `${lockPath}.stale.${process.pid}.${staleSeq++}`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        return false;
      }
      continue;
    }
    let movedIsLive = false;
    try {
      const moved = JSON.parse(
        await fs.readFile(stalePath, "utf-8")
      );
      movedIsLive = isProcessAlive(moved.pid);
    } catch (err) {
      movedIsLive = !(err instanceof SyntaxError);
    }
    if (movedIsLive) {
      await fs.link(stalePath, lockPath).catch(() => {
      });
      await fs.unlink(stalePath).catch(() => {
      });
      return false;
    }
    await fs.unlink(stalePath).catch(() => {
    });
  }
  return false;
}
__name(tryAcquireLock, "tryAcquireLock");
async function releaseLock(projectRoot, sessionId, lockId) {
  const lockPath = getLockFilePath(projectRoot);
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const existing = JSON.parse(raw);
    if (existing.pid === process.pid && existing.sessionId === sessionId && existing.lockId === lockId) {
      await fs.unlink(lockPath);
    }
  } catch {
  }
}
__name(releaseLock, "releaseLock");

// packages/core/src/services/cronScheduler.ts
var debugLogger = createDebugLogger("CRON_SCHEDULER");
var MAX_JOBS = 50;
var DEFAULT_RECURRING_MAX_AGE_DAYS = 7;
var DEFAULT_RECURRING_MAX_AGE_MS = DEFAULT_RECURRING_MAX_AGE_DAYS * 24 * 60 * 60 * 1e3;
function normalizeRecurringMaxAge(value, fallback) {
  if (value === 0) return Infinity;
  return value > 0 ? value : fallback;
}
__name(normalizeRecurringMaxAge, "normalizeRecurringMaxAge");
var MAX_RECURRING_JITTER_MS = 15 * 60 * 1e3;
var MAX_ONESHOT_JITTER_MS = 90 * 1e3;
var LOCK_PROBE_INTERVAL_MS = 5e3;
var FILE_DEBOUNCE_MS = 300;
var WAKEUP_MIN_SECONDS = 60;
var WAKEUP_MAX_SECONDS = 3600;
var WAKEUP_DEFAULT_SECONDS = 1200;
var WAKEUP_CHAIN_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function hashId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = hash * 31 + id.charCodeAt(i) | 0;
  }
  return Math.abs(hash);
}
__name(hashId, "hashId");
function computeJitter(id, cronExpr, recurring) {
  const hash = hashId(id);
  if (recurring) {
    const now = /* @__PURE__ */ new Date();
    try {
      const first = nextFireTime(cronExpr, now);
      const second = nextFireTime(cronExpr, first);
      const periodMs = second.getTime() - first.getTime();
      const tenPercent = periodMs * 0.1;
      const maxJitter = Math.min(tenPercent, MAX_RECURRING_JITTER_MS);
      return hash % Math.max(1, Math.floor(maxJitter));
    } catch {
      return 0;
    }
  }
  try {
    const next = nextFireTime(cronExpr, /* @__PURE__ */ new Date());
    if (next.getMinutes() % 30 === 0) {
      return -(hash % MAX_ONESHOT_JITTER_MS);
    }
  } catch {
  }
  return 0;
}
__name(computeJitter, "computeJitter");
function cronJitterWindowMinutes(jitterMs) {
  return Math.ceil(Math.abs(jitterMs) / 6e4);
}
__name(cronJitterWindowMinutes, "cronJitterWindowMinutes");
function isCronSlotVisibleToTick(slotMinuteMs, currentMs, jitterMs) {
  const currentMinute = new Date(currentMs);
  currentMinute.setSeconds(0, 0);
  return Math.abs(currentMinute.getTime() - slotMinuteMs) <= cronJitterWindowMinutes(jitterMs) * 6e4;
}
__name(isCronSlotVisibleToTick, "isCronSlotVisibleToTick");
var generateId = generateCronTaskId;
function clampWakeupSeconds(delaySeconds) {
  if (!Number.isFinite(delaySeconds)) return WAKEUP_DEFAULT_SECONDS;
  return Math.min(
    WAKEUP_MAX_SECONDS,
    Math.max(WAKEUP_MIN_SECONDS, Math.round(delaySeconds))
  );
}
__name(clampWakeupSeconds, "clampWakeupSeconds");
function wakeupToJob(wakeup) {
  return {
    id: wakeup.id,
    cronExpr: "@wakeup",
    prompt: wakeup.prompt,
    recurring: false,
    createdAt: wakeup.createdAt,
    expiresAt: Infinity,
    fireAtMs: wakeup.fireAtMs,
    jitterMs: 0,
    todoWorkChainId: wakeup.todoWorkChainId
  };
}
__name(wakeupToJob, "wakeupToJob");
function truncatePrompt(prompt) {
  return prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
}
__name(truncatePrompt, "truncatePrompt");
var CronScheduler = class {
  /** `projectRoot` anchors durable storage; without it only session-only
   * jobs work. Production constructs via `Config.getCronScheduler()`,
   * which always supplies it (and the configured `recurringMaxAgeMs`).
   * `normalizeRecurringMaxAge` owns the expiry contract for both this
   * constructor and the config layer: `0` and `Infinity` both mean
   * "never expire" — so a direct caller passing `0` gets disabled
   * expiry, not the default — while negative or NaN input falls back to
   * the 7-day default rather than expiring everything at birth. */
  constructor(projectRoot = null, recurringMaxAgeMs = DEFAULT_RECURRING_MAX_AGE_MS) {
    this.projectRoot = projectRoot;
    this.recurringMaxAgeMs = normalizeRecurringMaxAge(
      recurringMaxAgeMs,
      DEFAULT_RECURRING_MAX_AGE_MS
    );
  }
  static {
    __name(this, "CronScheduler");
  }
  // All jobs — session-only and durable — live in this one map.
  jobs = /* @__PURE__ */ new Map();
  // Loop wakeups live separately: second-resolution, never durable, never
  // counted against MAX_JOBS. Delivered through the same onFire as cron.
  wakeups = /* @__PURE__ */ new Map();
  // Start of the self-paced wakeup chain — a session-level 24h budget that
  // spans the whole session. Deliberately NOT reset when a wakeup fires or
  // is cancelled: re-arm leaves at most one pending wakeup, so resetting on
  // an empty map would restart the clock every fire and let a continuous
  // loop escape the cap. Reset only by stop()/destroy() (a new session).
  wakeupChainStartedAt = null;
  // Set once disable() runs (the session's token-limit breaker). Permanent
  // for this scheduler's lifetime — distinct from a stopped-but-restartable
  // timer, so LoopWakeup can reject wakeups that would never fire.
  _disabled = false;
  timer = null;
  onFire = null;
  // Guard a consumer installs when it cannot execute certain durable jobs. A
  // headless run can't expand a `.qwen/loop.md` sentinel, so it marks such
  // durable jobs skippable here: they are then neither fired NOR have their
  // persisted fired-state advanced (lastFiredAt stamp / one-shot removal),
  // leaving the tick for the owning interactive session instead of silently
  // consuming it for work the consumer never ran. Session-only jobs and durable
  // jobs in a consumer that can run them are unaffected (predicate unset/false).
  skipDurableFire = null;
  // --- Durable (file-backed) support ---
  durableEnabled = false;
  // Bumped by stop(). Async durable work captures the value before each
  // await and bails if it changed — a continuation that resumes after
  // stop() must not install state (or keep a lock) that stop() already
  // cleaned up or can no longer see.
  durableGeneration = 0;
  sessionId = null;
  // Distinguishes this scheduler's lock from one written by another
  // scheduler instance with the same pid+sessionId (session reload) —
  // adopting such a lock means owning a file whose unlink is in flight.
  lockId = generateId();
  // Release from a previous stop() that may not have landed yet. A new
  // acquire must wait it out so it can't grab the doomed lock file.
  pendingRelease = null;
  isOwner = false;
  // Durable ids whose on-disk removal hasn't landed yet — a reload that
  // reads the file before the write completes must not resurrect them.
  pendingRemoval = /* @__PURE__ */ new Set();
  // Durable ids whose initial on-disk write hasn't landed yet — a reload
  // that reads the file before the write completes must not reconcile
  // the live job away (or clear its pendingRemoval guard) as if it had
  // been deleted on disk.
  pendingAdd = /* @__PURE__ */ new Set();
  // Durable one-shots this continuously-running scheduler loaded while it was
  // eligible to fire them. Cleared on stop so a later enable still treats
  // genuinely overdue work as missed.
  armedDurableOneShots = /* @__PURE__ */ new Set();
  // Exact persisted snapshots for active per-run one-shots. The tick removes
  // such a task before its async fresh-session dispatch finishes; retain the
  // original so a rejected dispatch can put the unexecuted task back without
  // dropping route-only fields such as session ownership.
  restorablePerRunOneShots = /* @__PURE__ */ new Map();
  consumedPerRunOneShots = /* @__PURE__ */ new Set();
  // The durable deletion generation observed by the task-file mutation that
  // removed each consumed one-shot.
  consumedPerRunRemovalGenerations = /* @__PURE__ */ new Map();
  // Ids of legacy tasks (a pre-removal `isolated` task with a `condition`
  // precondition) already reported as skipped, so the fail-closed remediation
  // breadcrumb is logged once per task rather than on every file reload.
  warnedLegacyConditionIds = /* @__PURE__ */ new Set();
  // Ids of bare `runMode: 'isolated'` legacy tasks already warned about — they
  // still run (no safety gate), so this is a one-time behavior-change notice.
  warnedLegacyRunModeIds = /* @__PURE__ */ new Set();
  // Durable ids whose lastFiredAt persist is in flight after a fire — the tick
  // (on-time) OR a catch-up delivery. A reload racing that async write reads the
  // stale disk stamp, so it must not re-detect and re-fire the same slot. Only
  // populated once a fire has actually been stamped/delivered, so a catch-up that
  // was merely buffered and then dropped never enters it and still re-detects.
  //
  // REF-COUNTED per id (not a plain Set): the same task can have two persists in
  // flight at once (it fired again before the first write landed). Clearing on
  // the FIRST settle would drop the guard while the second write is still
  // pending; the count keeps it until the LAST in-flight persist for that id
  // settles.
  //
  // LIMITATION: this guard is INSTANCE-scoped in-memory state. It protects
  // against a reload racing a persist WITHIN one scheduler. It does NOT survive
  // a new scheduler instance (daemon restart, keepalive revive, session reload):
  // a fresh instance starts with an empty map, so if the previous instance died
  // with a persist still in flight, the new one reads the stale on-disk stamp
  // and can re-fire that slot once. Fully closing that narrow cross-instance
  // window would need a durable stamp (in the tasks file or a lock file); it's
  // accepted here as a sub-second restart-timing edge.
  firePersistPending = /* @__PURE__ */ new Map();
  markFirePersistPending(ids) {
    for (const id of ids) {
      this.firePersistPending.set(
        id,
        (this.firePersistPending.get(id) ?? 0) + 1
      );
    }
  }
  clearFirePersistPending(ids) {
    for (const id of ids) {
      const next = (this.firePersistPending.get(id) ?? 0) - 1;
      if (next > 0) this.firePersistPending.set(id, next);
      else this.firePersistPending.delete(id);
    }
  }
  fileWatcher = null;
  lockProbeTimer = null;
  debounceTimer = null;
  // Test-only auto-fire timers (QWEN_CODE_TEST_CRON_FAST). Each timer
  // fires its job via forceFireJob after a short delay so integration
  // tests don't wait for the wall-clock minute boundary. Cleared on
  // stop()/destroy() so a session teardown never leaks a pending fire.
  testFireTimers = /* @__PURE__ */ new Map();
  // Catch-up work detected before start() installed onFire — flushed
  // through onFire as soon as it exists.
  pendingFires = [];
  // Fire-and-forget writes (tick persists, delivered missed-fire
  // removals), chained so stop() can hold the lock until they land — a
  // successor reading the file pre-write would re-run the same work.
  pendingPersist = Promise.resolve();
  /** Age after which recurring jobs expire, evaluated at fire time.
   * Infinity = never expire. Guarded in the constructor. */
  recurringMaxAgeMs;
  /**
   * Creates a new session-only cron job. Returns the created job.
   * Throws if the max job limit is reached.
   */
  create(cronExpr, prompt, recurring) {
    if (this.jobs.size >= MAX_JOBS) {
      throw new Error(
        `Maximum number of cron jobs (${MAX_JOBS}) reached. Delete some jobs first.`
      );
    }
    const id = generateId();
    const now = Date.now();
    const jitterMs = computeJitter(id, cronExpr, recurring);
    const job = {
      id,
      cronExpr,
      prompt,
      recurring,
      createdAt: now,
      expiresAt: recurring ? now + this.recurringMaxAgeMs : Infinity,
      // Prevent the scheduler from firing during the creation minute
      lastFiredAt: now - now % 6e4,
      jitterMs
    };
    this.jobs.set(id, job);
    if (process.env["QWEN_CODE_TEST_CRON_FAST"] === "1" && !job.durable) {
      const delayMs = Number(process.env["QWEN_CODE_TEST_CRON_DELAY_MS"]) || 5e3;
      const timer = setTimeout(() => {
        this.testFireTimers.delete(id);
        this.forceFireJob(id);
      }, delayMs);
      timer.unref();
      this.testFireTimers.set(id, timer);
      debugLogger.debug(
        `Test seam: auto-fire scheduled for job ${id} in ${delayMs}ms`
      );
    }
    return job;
  }
  /**
   * Schedules a second-resolution, session-only one-shot wakeup for
   * self-paced `/loop`. Clamps `delaySeconds` to [60, 3600]; non-finite
   * input falls back to the default heartbeat. The fire time is exact (not
   * minute-rounded) and is not subject to MAX_JOBS. Returns the scheduling
   * outcome for the model (mirrors ScheduleWakeup's output).
   */
  scheduleWakeup(delaySeconds, prompt, todoWorkChainId) {
    if (this._disabled) {
      throw new Error(
        "Cannot schedule a loop wakeup: the scheduler is disabled for this session. Restart the session to re-enable."
      );
    }
    const clampedDelaySeconds = clampWakeupSeconds(delaySeconds);
    const roundedDelaySeconds = Number.isFinite(delaySeconds) ? Math.round(delaySeconds) : delaySeconds;
    const wasClamped = !Number.isFinite(delaySeconds) || roundedDelaySeconds < WAKEUP_MIN_SECONDS || roundedDelaySeconds > WAKEUP_MAX_SECONDS;
    const id = generateId();
    const now = Date.now();
    const fireAtMs = now + clampedDelaySeconds * 1e3;
    const replacedWakeup = this.wakeups.values().next().value ?? null;
    const replacedId = replacedWakeup?.id ?? null;
    if (this.wakeupChainStartedAt === null) {
      this.wakeupChainStartedAt = now;
    }
    this.wakeups.clear();
    if (fireAtMs > this.wakeupChainStartedAt + WAKEUP_CHAIN_MAX_AGE_MS) {
      throw new Error(
        "Loop wakeup chain exceeded the 24h session limit. Omit LoopWakeup to end this loop, or start a new session."
      );
    }
    if (replacedId) {
      debugLogger.debug(`Replacing pending wakeup ${replacedId}`);
    }
    this.wakeups.set(id, {
      id,
      fireAtMs,
      prompt,
      createdAt: now,
      todoWorkChainId
    });
    debugLogger.debug(
      `Wakeup ${id} scheduled for ${new Date(fireAtMs).toISOString()} (delay=${clampedDelaySeconds}s)`
    );
    return {
      id,
      scheduledFor: new Date(fireAtMs).toISOString(),
      clampedDelaySeconds,
      wasClamped,
      replacedId
    };
  }
  /** Cancels a single pending wakeup. Returns true if it existed. */
  cancelWakeup(id) {
    const deleted = this.wakeups.delete(id);
    if (deleted) {
      debugLogger.debug(`Cancelled wakeup ${id}`);
    }
    return deleted;
  }
  /**
   * Cancels every pending wakeup; returns how many were cancelled. The
   * primitive behind a future loop-scoped "cancel all wakeups on abort".
   */
  cancelAllWakeups() {
    const count = this.wakeups.size;
    this.wakeups.clear();
    if (count > 0) debugLogger.debug(`Cancelled ${count} wakeup(s)`);
    return count;
  }
  /**
   * Creates a durable cron job: registered like any other job, and
   * persisted under ~/.qwen (per-project) so it survives restarts.
   * Throws if the job can't be persisted.
   */
  async createDurable(cronExpr, prompt, recurring) {
    if (!this.projectRoot) {
      throw new Error("Durable cron jobs require a project root.");
    }
    const job = this.create(cronExpr, prompt, recurring);
    job.durable = true;
    this.pendingAdd.add(job.id);
    try {
      await addCronTask(this.projectRoot, jobToDurableTask(job));
      if (!job.recurring && this.durableEnabled && this.#shouldFireDurable(job)) {
        this.armedDurableOneShots.add(job.id);
      }
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    } finally {
      this.pendingAdd.delete(job.id);
    }
    return job;
  }
  /**
   * Deletes a job by ID. Durable jobs are also removed from disk, and the
   * removal is awaited — reporting success while the on-disk entry could
   * survive would let the task resurface in another session or after a
   * restart. On write failure the job is restored and the error rethrown.
   * Returns true if the job existed.
   */
  async delete(id) {
    const job = this.jobs.get(id);
    if (!job) {
      this.restorablePerRunOneShots.delete(id);
      this.consumedPerRunOneShots.delete(id);
      this.consumedPerRunRemovalGenerations.delete(id);
      return this.cancelWakeup(id);
    }
    this.jobs.delete(id);
    if (job.durable && this.projectRoot) {
      this.pendingRemoval.add(id);
      try {
        await removeCronTasks(this.projectRoot, [id]);
      } catch (error) {
        this.pendingRemoval.delete(id);
        this.jobs.set(id, job);
        throw error;
      }
    }
    this.restorablePerRunOneShots.delete(id);
    this.consumedPerRunOneShots.delete(id);
    this.consumedPerRunRemovalGenerations.delete(id);
    this.armedDurableOneShots.delete(id);
    return true;
  }
  /**
   * Returns all active jobs.
   */
  list() {
    return [
      ...this.jobs.values(),
      ...[...this.wakeups.values()].map(wakeupToJob)
    ];
  }
  /**
   * Returns the number of active jobs and wakeups.
   */
  get size() {
    return this.jobs.size + this.wakeups.size;
  }
  /**
   * Returns the number of session-only (non-durable) jobs. Headless mode
   * keys its hold-open loop on this: durable jobs outlive the process by
   * design and never fire without lock ownership, so they must not pin it.
   */
  get sessionSize() {
    let count = this.wakeups.size;
    for (const job of this.jobs.values()) {
      if (!job.durable) count++;
    }
    return count;
  }
  /**
   * Enables durable cron support. Loads tasks from disk and watches the
   * tasks file in every session — durable tasks are project-level, so
   * cron_list/cron_delete must see them regardless of which session owns
   * the lock. The lock only gates firing.
   */
  async enableDurable(sessionId) {
    if (this.durableEnabled) return;
    const projectRoot = this.projectRoot;
    if (!projectRoot) return;
    this.durableEnabled = true;
    this.sessionId = sessionId;
    const generation = this.durableGeneration;
    try {
      if (this.pendingRelease) {
        await this.pendingRelease;
        this.pendingRelease = null;
        if (generation !== this.durableGeneration) return;
      }
      const acquired = await tryAcquireLock(
        projectRoot,
        sessionId,
        this.lockId
      );
      if (generation !== this.durableGeneration) {
        this.releaseLateAcquisition(acquired, projectRoot, sessionId);
        return;
      }
      this.isOwner = acquired;
      this.startFileWatcher(projectRoot);
      await this.loadFileTasks(this.isOwner);
      if (generation !== this.durableGeneration) {
        return;
      }
      if (!this.isOwner) {
        this.lockProbeTimer = setInterval(() => {
          void tryAcquireLock(projectRoot, sessionId, this.lockId).then((acquired2) => {
            if (generation !== this.durableGeneration) {
              this.releaseLateAcquisition(acquired2, projectRoot, sessionId);
              return;
            }
            if (acquired2 && !this.isOwner) {
              this.isOwner = true;
              if (this.lockProbeTimer) {
                clearInterval(this.lockProbeTimer);
                this.lockProbeTimer = null;
              }
              void this.loadFileTasks(true).catch((err) => {
                debugLogger.warn(`Cron takeover reload failed: ${err}`);
              });
            }
          }).catch((err) => {
            debugLogger.warn(`Cron lock probe failed: ${err}`);
          });
        }, LOCK_PROBE_INTERVAL_MS);
        this.lockProbeTimer.unref();
      }
    } catch (error) {
      if (generation === this.durableGeneration) {
        if (this.isOwner) {
          this.pendingRelease = releaseLock(
            projectRoot,
            sessionId,
            this.lockId
          );
          this.isOwner = false;
        }
        this.durableEnabled = false;
        this.sessionId = null;
      }
      throw error;
    }
  }
  /**
   * Hands back a lock acquired by an await that resumed after stop() —
   * unless a newer enableDurable() for the same session is already active
   * on this scheduler, in which case the lock is exactly the one it owns
   * (acquisition is idempotent per pid+sessionId+lockId) and releasing
   * would pull it out from under it.
   */
  releaseLateAcquisition(acquired, projectRoot, sessionId) {
    if (!acquired) return;
    if (this.durableEnabled && this.sessionId === sessionId) return;
    this.pendingRelease = releaseLock(projectRoot, sessionId, this.lockId);
  }
  async loadFileTasks(handleMissed) {
    const projectRoot = this.projectRoot;
    if (!projectRoot) return;
    const generation = this.durableGeneration;
    let read;
    try {
      read = await readCronTasks(projectRoot);
    } catch {
      if (this.jobs.size > 0) {
        console.warn(
          "CronScheduler: durable tasks reload failed; keeping the previous schedule (a just-disabled or -deleted task may keep firing until the next successful reload)."
        );
      }
      return;
    }
    if (generation !== this.durableGeneration) {
      return;
    }
    const tasks = read.filter((t) => {
      if (!hasParseableCron(t) || t.enabled === false) return false;
      if (taskHasLegacyCondition(t)) {
        if (!this.warnedLegacyConditionIds.has(t.id)) {
          this.warnedLegacyConditionIds.add(t.id);
          console.warn(
            `CronScheduler: scheduled task ${t.id} carries a legacy precondition (isolated run mode was removed) and will NOT fire \u2014 recreate it if you still want it to run.`
          );
        }
        return false;
      }
      if (taskHasLegacyRunMode(t) && !this.warnedLegacyRunModeIds.has(t.id)) {
        this.warnedLegacyRunModeIds.add(t.id);
        console.warn(
          `CronScheduler: scheduled task ${t.id} was created with the removed 'isolated' run mode; it now runs in its bound session (history accumulates across runs). Recreate it and call create_sub_session from the prompt for per-run isolation.`
        );
      }
      return true;
    });
    const now = Date.now();
    const missedOneShots = [];
    const catchUpIds = [];
    const finalTasks = [];
    {
      for (const t of tasks) {
        if (this.pendingRemoval.has(t.id)) continue;
        const responsibleForMissed = typeof t.sessionId === "string" && t.sessionId.length > 0 ? t.sessionId === this.sessionId : handleMissed;
        if (!responsibleForMissed) continue;
        if (this.firePersistPending.has(t.id)) continue;
        const jitter = computeJitter(t.id, t.cron, t.recurring);
        const anchor = t.recurring ? t.lastFiredAt ?? t.createdAt : t.createdAt;
        const nextFire = computeNextFireMs(t.cron, anchor, jitter);
        if (nextFire === null || nextFire >= now) continue;
        if (!t.recurring && this.timer !== null && this.armedDurableOneShots.has(t.id) && isCronSlotVisibleToTick(nextFire - jitter, now, jitter))
          continue;
        if (!t.recurring) {
          missedOneShots.push(t);
        } else if (now - t.createdAt >= this.recurringMaxAgeMs) {
          console.warn(
            `Durable cron task ${t.id} (created ${new Date(
              t.createdAt
            ).toISOString()}) is past the recurring max age at load; it will fire one final time and be deleted.`
          );
          finalTasks.push(t);
        } else {
          catchUpIds.push(t.id);
        }
      }
      for (const t of [...missedOneShots, ...finalTasks]) {
        this.pendingRemoval.add(t.id);
        this.armedDurableOneShots.delete(t.id);
        this.jobs.delete(t.id);
      }
    }
    const diskIds = new Set(tasks.map((t) => t.id));
    for (const id of this.pendingAdd) diskIds.add(id);
    for (const id of this.restorablePerRunOneShots.keys()) {
      if (!diskIds.has(id) && !this.consumedPerRunOneShots.has(id)) {
        this.restorablePerRunOneShots.delete(id);
      }
    }
    for (const job of this.jobs.values()) {
      if (job.durable && !diskIds.has(job.id)) {
        this.jobs.delete(job.id);
        this.armedDurableOneShots.delete(job.id);
      }
    }
    for (const id of this.pendingRemoval) {
      if (!diskIds.has(id)) this.pendingRemoval.delete(id);
    }
    let durableJobCount = 0;
    for (const j of this.jobs.values()) if (j.durable) durableJobCount++;
    for (const task of tasks) {
      if (this.pendingRemoval.has(task.id)) continue;
      const existing = this.jobs.get(task.id);
      if (!existing && durableJobCount >= MAX_JOBS) {
        debugLogger.warn(
          `Durable task ${task.id} skipped \u2014 durable cap (${MAX_JOBS}) reached.`
        );
        continue;
      }
      const job = durableTaskToJob(task, this.recurringMaxAgeMs, existing);
      if (existing?.lastFiredAt !== void 0) {
        job.lastFiredAt = Math.max(existing.lastFiredAt, job.lastFiredAt ?? 0);
      }
      this.jobs.set(task.id, job);
      if (!task.recurring && task.sessionMode === "per_run") {
        this.restorablePerRunOneShots.set(task.id, {
          task,
          index: read.findIndex((candidate) => candidate.id === task.id)
        });
      } else {
        this.restorablePerRunOneShots.delete(task.id);
        this.consumedPerRunOneShots.delete(task.id);
      }
      if (!task.recurring && this.#shouldFireDurable(job)) {
        this.armedDurableOneShots.add(task.id);
      } else {
        this.armedDurableOneShots.delete(task.id);
      }
      if (!existing) durableJobCount++;
    }
    if (catchUpIds.length > 0) {
      const nowMinuteMs = now - now % 6e4;
      for (const id of catchUpIds) {
        const job = this.jobs.get(id);
        if (job) job.lastFiredAt = nowMinuteMs;
      }
    }
    if (missedOneShots.length > 0) {
      this.fireOrBuffer({ kind: "missed", tasks: missedOneShots });
    }
    if (catchUpIds.length > 0) {
      this.fireOrBuffer({ kind: "catch-up", ids: catchUpIds });
    }
    if (finalTasks.length > 0) {
      this.fireOrBuffer({
        kind: "final",
        jobs: finalTasks.map(
          (t) => durableTaskToJob(t, this.recurringMaxAgeMs)
        )
      });
    }
  }
  /**
   * Delivers catch-up work through the normal onFire channel, or holds
   * it until start() installs one. Delivery is what removes a missed or
   * final task from disk (and what persists a catch-up stamp) — a
   * buffered fire leaves disk state untouched, so a stop() that drops
   * the buffer loses nothing.
   */
  fireOrBuffer(pending) {
    if (this.onFire) {
      this.deliverPending(pending, this.onFire);
    } else {
      this.pendingFires.push(pending);
    }
  }
  deliverPending(pending, onFire) {
    switch (pending.kind) {
      case "missed": {
        const skipped = [];
        const runnable = pending.tasks.filter((t) => {
          const job = durableTaskToJob(t, this.recurringMaxAgeMs);
          if (job.durable && this.skipDurableFire?.(job)) {
            debugLogger.debug(
              `Skipping durable job ${t.id} (missed): consumer cannot run it`
            );
            skipped.push(t.id);
            return false;
          }
          return true;
        });
        for (const id of skipped) this.pendingRemoval.delete(id);
        if (runnable.length > 0) {
          const carrier = durableTaskToJob(
            runnable[0],
            this.recurringMaxAgeMs
          );
          onFire({
            ...carrier,
            prompt: buildMissedCronNotification(runnable),
            missed: true,
            delivery: void 0
          });
          this.removeMissedFromDisk(runnable.map((t) => t.id));
        }
        break;
      }
      case "catch-up": {
        const fired = [];
        for (const id of pending.ids) {
          const job = this.jobs.get(id);
          if (!job) continue;
          if (job.durable && this.skipDurableFire?.(job)) {
            debugLogger.debug(
              `Skipping durable job ${job.id} (catch-up): consumer cannot run it`
            );
            continue;
          }
          onFire(job);
          fired.push(id);
        }
        this.persistCatchUpStamps(fired);
        break;
      }
      case "final": {
        const fired = [];
        for (const job of pending.jobs) {
          if (job.durable && this.skipDurableFire?.(job)) {
            debugLogger.debug(
              `Skipping durable job ${job.id} (final): consumer cannot run it`
            );
            this.pendingRemoval.delete(job.id);
            continue;
          }
          onFire(job);
          fired.push(job.id);
        }
        this.removeMissedFromDisk(fired);
        break;
      }
      default: {
        const _exhaustive = pending;
        return _exhaustive;
      }
    }
  }
  /**
   * Persists the in-memory lastFiredAt stamps of just-delivered catch-up
   * fires so a restart doesn't replay them.
   */
  persistCatchUpStamps(ids) {
    if (!this.projectRoot || ids.length === 0) return;
    const stamps = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const fired = this.jobs.get(id)?.lastFiredAt;
      if (fired !== void 0) stamps.set(id, fired);
    }
    if (stamps.size === 0) return;
    const guarded = [...stamps.keys()];
    this.markFirePersistPending(guarded);
    this.trackPersist(
      updateCronTasks(this.projectRoot, (tasks) => {
        let changed = false;
        const next = tasks.map((t) => {
          const stamp = stamps.get(t.id);
          if (stamp === void 0 || (t.lastFiredAt ?? 0) >= stamp) return t;
          changed = true;
          return {
            ...t,
            lastFiredAt: stamp,
            runs: appendCronRun(t.runs, {
              at: stamp,
              kind: "catch-up",
              ...t.sessionMode !== "per_run" && this.sessionId ? { sessionId: this.sessionId } : {}
            })
          };
        });
        return changed ? next : tasks;
      }).finally(() => {
        this.clearFirePersistPending(guarded);
      })
    );
  }
  /** Launches the on-disk removal of missed/final tasks just delivered. */
  removeMissedFromDisk(ids) {
    if (!this.projectRoot || ids.length === 0) return;
    this.trackPersist(removeCronTasks(this.projectRoot, ids));
  }
  /**
   * Chains a background write into pendingPersist so stop() releases the
   * lock only after it lands. Failures are logged but not retried — same
   * best-effort contract as a fire-and-forget persist; the fire was
   * already delivered, so a failed stamp degrades to at-least-once.
   */
  trackPersist(write) {
    const settled = write.then(
      () => {
      },
      (err) => {
        debugLogger.warn(
          `Durable cron persist failed \u2014 disk state is stale and the task may fire again in a later session: ${err}`
        );
      }
    );
    this.pendingPersist = this.pendingPersist.then(() => settled);
  }
  startFileWatcher(projectRoot) {
    if (this.fileWatcher) return;
    const filePath = getCronFilePath(projectRoot);
    const dir = path2.dirname(filePath);
    const fileName = path2.basename(filePath);
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      this.fileWatcher = fsSync.watch(
        dir,
        { persistent: false },
        (_event, filename) => {
          if (filename && filename !== fileName) return;
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            void this.loadFileTasks(false);
          }, FILE_DEBOUNCE_MS);
          this.debounceTimer.unref();
        }
      );
      this.fileWatcher.on("error", (err) => {
        debugLogger.warn(
          `Tasks-file watcher error \u2014 durable task changes from other sessions may not be picked up until restart: ${err}`
        );
      });
    } catch {
    }
  }
  /**
   * Installs a predicate marking durable jobs the active consumer cannot run
   * (see the `skipDurableFire` field). Such jobs are skipped before any fire or
   * persist, so their durable schedule is left intact for an owning session that
   * can run them. Set before `start()` so a buffered catch-up flush also honors
   * it. A no-op for session-only jobs.
   */
  setSkipDurableFire(predicate) {
    this.skipDurableFire = predicate;
  }
  /**
   * Immediately fires a job by ID, bypassing the cron schedule check.
   * Sets lastFiredAt to prevent the normal tick from re-firing the same
   * minute slot. Returns true if the job existed and was fired, false
   * otherwise. Primarily a test seam (see QWEN_CODE_TEST_CRON_FAST in
   * create()); also useful for manual debug triggers.
   */
  forceFireJob(id) {
    const job = this.jobs.get(id);
    if (!job || !this.onFire) return false;
    job.lastFiredAt = Date.now();
    debugLogger.debug(`forceFireJob: firing ${id} (${job.cronExpr})`);
    this.onFire(job);
    return true;
  }
  /** Attributes an already-persisted per-run fire to the session it ran in,
   * and/or marks its fresh-session creation as failed. */
  async annotateRunSession(taskId, firedAt, outcome) {
    if (outcome.sessionId && this.consumedPerRunOneShots.delete(taskId)) {
      this.restorablePerRunOneShots.delete(taskId);
      this.consumedPerRunRemovalGenerations.delete(taskId);
    }
    if (!this.projectRoot) return;
    await Promise.resolve();
    await this.pendingPersist;
    await updateCronTasks(
      this.projectRoot,
      (tasks) => tasks.map(
        (task) => task.id === taskId ? annotateCronRunSession(task, firedAt, outcome) : task
      )
    );
  }
  /** Pauses and records a durable per-run one-shot that never dispatched. */
  async restoreConsumedOneShot(taskId) {
    const projectRoot = this.projectRoot;
    const snapshot = this.restorablePerRunOneShots.get(taskId);
    const firedAt = snapshot?.task.lastFiredAt;
    if (!projectRoot || !snapshot || firedAt == null || !this.consumedPerRunOneShots.has(taskId)) {
      return false;
    }
    await Promise.resolve();
    await this.pendingPersist;
    const removalGeneration = this.consumedPerRunRemovalGenerations.get(taskId);
    if (!this.consumedPerRunOneShots.has(taskId) || removalGeneration === void 0) {
      this.restorablePerRunOneShots.delete(taskId);
      this.consumedPerRunOneShots.delete(taskId);
      this.consumedPerRunRemovalGenerations.delete(taskId);
      return false;
    }
    this.armedDurableOneShots.delete(taskId);
    let restoreGenerations = /* @__PURE__ */ new Map();
    let restored = false;
    try {
      await updateCronTasks(
        projectRoot,
        (tasks) => {
          if ([...removalGeneration].some(
            ([id, generation]) => restoreGenerations.get(id) !== generation
          ))
            return tasks;
          const existing = tasks.findIndex((task) => task.id === taskId);
          const current = tasks[existing] ?? snapshot.task;
          const failed = {
            ...current,
            enabled: false,
            lastFiredAt: firedAt,
            runs: appendCronRun(current.runs, {
              at: firedAt,
              kind: "scheduled",
              sessionDispatchFailed: true
            })
          };
          restored = true;
          if (existing !== -1) {
            return tasks.map(
              (task, index) => index === existing ? failed : task
            );
          }
          const next = [...tasks];
          next.splice(Math.min(snapshot.index, next.length), 0, failed);
          return next;
        },
        {
          observeDeletionIds: [...removalGeneration.keys()],
          onDeletionGenerations: /* @__PURE__ */ __name((generations) => {
            restoreGenerations = generations;
          }, "onDeletionGenerations")
        }
      );
    } catch (error) {
      this.restorablePerRunOneShots.delete(taskId);
      this.consumedPerRunOneShots.delete(taskId);
      this.consumedPerRunRemovalGenerations.delete(taskId);
      console.warn(
        `CronScheduler: could not restore scheduled one-shot task ${taskId} after its run failed to dispatch \u2014 the task may be gone from disk with no recorded run.`
      );
      throw error;
    }
    if (!restored) {
      this.restorablePerRunOneShots.delete(taskId);
      this.consumedPerRunOneShots.delete(taskId);
      this.consumedPerRunRemovalGenerations.delete(taskId);
      return false;
    }
    this.pendingRemoval.delete(taskId);
    this.jobs.delete(taskId);
    this.consumedPerRunOneShots.delete(taskId);
    this.consumedPerRunRemovalGenerations.delete(taskId);
    return true;
  }
  /**
   * Starts the scheduler tick. Calls `onFire` when a job is due.
   * Only fires when called — does not auto-fire missed intervals.
   */
  start(onFire) {
    this.onFire = onFire;
    for (const pending of this.pendingFires.splice(0)) {
      this.deliverPending(pending, onFire);
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, 1e3);
  }
  /**
   * Stops the scheduler and relinquishes durable participation: the lock
   * is released so another session can take over, and a later
   * `enableDurable()` re-acquires from scratch (a re-enable under a new
   * sessionId must not be blocked by this session's own old lock).
   * Does not clear cron jobs — they remain queryable. Pending wakeups are
   * cleared because they are session-scoped and meaningless without a timer.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lockProbeTimer) {
      clearInterval(this.lockProbeTimer);
      this.lockProbeTimer = null;
    }
    if (this.fileWatcher) {
      void closeFileWatcher(this.fileWatcher);
      this.fileWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const timer of this.testFireTimers.values()) clearTimeout(timer);
    this.testFireTimers.clear();
    if (this.wakeups.size > 0) {
      debugLogger.debug(`stop() discarding ${this.wakeups.size} wakeup(s)`);
      this.wakeups.clear();
    }
    this.wakeupChainStartedAt = null;
    this.onFire = null;
    this.armedDurableOneShots.clear();
    if (this.durableEnabled) {
      this.durableGeneration++;
      if (this.isOwner && this.projectRoot && this.sessionId) {
        const projectRoot = this.projectRoot;
        const sessionId = this.sessionId;
        this.pendingRelease = this.pendingPersist.then(
          () => releaseLock(projectRoot, sessionId, this.lockId)
        );
      }
      this.isOwner = false;
      this.durableEnabled = false;
      for (const pending of this.pendingFires) {
        if (pending.kind === "missed") {
          for (const t of pending.tasks) this.pendingRemoval.delete(t.id);
        } else if (pending.kind === "final") {
          for (const j of pending.jobs) this.pendingRemoval.delete(j.id);
        }
      }
      this.pendingFires.length = 0;
    }
  }
  /**
   * True while durable (file-backed) support is active — this session is
   * either firing durable tasks (owner) or probing to take over.
   */
  get durableActive() {
    return this.durableEnabled;
  }
  /**
   * True when the tick loop has — or may acquire — work: any in-memory
   * job, or durable mode active (the file watcher and lock takeover can
   * install fireable tasks at any time, even while the map is empty).
   */
  get hasPendingWork() {
    return this.jobs.size > 0 || this.wakeups.size > 0 || this.durableEnabled;
  }
  /**
   * Returns true if the scheduler is running.
   */
  get running() {
    return this.timer !== null;
  }
  /**
   * True once disable() has run. Distinct from `!running`: a fresh scheduler
   * is stopped but not disabled, and starts on first pending work. Used by
   * LoopWakeup to reject wakeups that would never fire (vs. ones that will
   * fire once the post-prompt hook starts the tick).
   */
  get disabled() {
    return this._disabled;
  }
  /**
   * Permanently disables the scheduler for this session: stops the tick and
   * marks it disabled so LoopWakeup rejects new wakeups. Only the token-limit
   * breaker calls this; cleared only by a new session (a fresh instance).
   */
  disable() {
    this._disabled = true;
    this.stop();
  }
  /**
   * Whether THIS session should fire a given durable job:
   *  - A session-bound task (`boundSessionId` set) fires only in its own
   *    session, independent of the per-project lock — so each task's fires
   *    land in its dedicated transcript and no two sessions race it.
   *  - An unbound task fires only in the lock owner (the legacy shared model).
   * A task bound to a *different* session is never fired here.
   */
  #shouldFireDurable(job) {
    if (job.boundSessionId !== void 0) {
      return job.boundSessionId === this.sessionId;
    }
    return this.isOwner;
  }
  /**
   * Manual tick — checks all jobs against the current time and fires those
   * that are due. Exported for testing.
   */
  tick(now) {
    if (this.jobs.size === 0 && this.wakeups.size === 0) return;
    const currentDate = now ?? /* @__PURE__ */ new Date();
    const currentMs = currentDate.getTime();
    const firedAt = /* @__PURE__ */ new Map();
    const removedIds = [];
    for (const job of this.jobs.values()) {
      if (job.durable && !this.#shouldFireDurable(job)) continue;
      if (job.durable && this.skipDurableFire?.(job)) {
        debugLogger.debug(
          `Skipping durable job ${job.id} (tick): consumer cannot run it`
        );
        continue;
      }
      const result = this.processJob(job, currentDate, currentMs);
      if (!job.durable || result === "none") continue;
      if (result === "fired-final" || !job.recurring) {
        removedIds.push(job.id);
      } else {
        firedAt.set(job.id, job.lastFiredAt);
      }
    }
    if (this.projectRoot && (firedAt.size > 0 || removedIds.length > 0)) {
      for (const id of removedIds) {
        this.pendingRemoval.add(id);
        this.armedDurableOneShots.delete(id);
      }
      const removed = new Set(removedIds);
      const removedByFire = /* @__PURE__ */ new Set();
      let removalGenerations = /* @__PURE__ */ new Map();
      const guarded = [...firedAt.keys()];
      this.markFirePersistPending(guarded);
      const recordRemovalGenerations = /* @__PURE__ */ __name(() => {
        for (const id of removedByFire) {
          const generation = removalGenerations.get(id);
          if (generation !== void 0 && this.consumedPerRunOneShots.has(id)) {
            const observed = /* @__PURE__ */ new Map([[id, generation]]);
            const sessionId = this.restorablePerRunOneShots.get(id)?.task.sessionId;
            if (sessionId) {
              const key = cronTaskSessionDeletionId(sessionId);
              const sessionGeneration = removalGenerations.get(key);
              if (sessionGeneration === void 0) continue;
              observed.set(key, sessionGeneration);
            }
            this.consumedPerRunRemovalGenerations.set(id, observed);
          }
        }
      }, "recordRemovalGenerations");
      this.trackPersist(
        updateCronTasks(
          this.projectRoot,
          (tasks) => tasks.filter((t) => {
            if (!removed.has(t.id)) return true;
            removedByFire.add(t.id);
            const snapshot = this.restorablePerRunOneShots.get(t.id);
            if (snapshot) {
              snapshot.task = {
                ...t,
                lastFiredAt: snapshot.task.lastFiredAt
              };
            }
            return false;
          }).map((t) => {
            const stamp = firedAt.get(t.id);
            if (stamp === void 0 || (t.lastFiredAt ?? 0) >= stamp)
              return t;
            return {
              ...t,
              lastFiredAt: stamp,
              runs: appendCronRun(t.runs, {
                at: stamp,
                kind: "scheduled",
                // The owner session that ran this fire — links the run back
                // to its transcript. Set whenever a durable fire persists.
                ...t.sessionMode !== "per_run" && this.sessionId ? { sessionId: this.sessionId } : {}
              })
            };
          }),
          {
            observeDeletionIds: /* @__PURE__ */ __name((tasks) => [
              ...removedIds,
              ...tasks.flatMap(
                (task) => removed.has(task.id) && task.sessionId ? [cronTaskSessionDeletionId(task.sessionId)] : []
              )
            ], "observeDeletionIds"),
            onDeletionGenerations: /* @__PURE__ */ __name((generations) => {
              removalGenerations = generations;
            }, "onDeletionGenerations")
          }
        ).then(recordRemovalGenerations, (error) => {
          recordRemovalGenerations();
          throw error;
        }).finally(() => {
          this.clearFirePersistPending(guarded);
        })
      );
    }
    for (const wakeup of this.wakeups.values()) {
      if (wakeup.fireAtMs > currentMs) continue;
      this.wakeups.delete(wakeup.id);
      debugLogger.debug(`Firing wakeup ${wakeup.id}`);
      if (this.onFire) this.onFire(wakeupToJob(wakeup));
    }
  }
  /**
   * Processes a single job. Returns 'fired' if the job fired,
   * 'fired-final' if it fired one last time and was removed (aged out),
   * and 'none' otherwise.
   */
  processJob(job, currentDate, currentMs) {
    const windowMinutes = cronJitterWindowMinutes(job.jitterMs);
    const nowMinuteStart = new Date(currentDate);
    nowMinuteStart.setSeconds(0, 0);
    const nowMinuteMs = nowMinuteStart.getTime();
    let matchedMinuteMs = null;
    for (let offset = -windowMinutes; offset <= windowMinutes; offset++) {
      const candidateMs = nowMinuteMs + offset * 6e4;
      const candidateDate = new Date(candidateMs);
      if (!matches(job.cronExpr, candidateDate)) continue;
      const fireTimeMs = candidateMs + job.jitterMs;
      if (currentMs >= fireTimeMs) {
        if (matchedMinuteMs === null || candidateMs > matchedMinuteMs) {
          matchedMinuteMs = candidateMs;
        }
      }
    }
    if (matchedMinuteMs === null) return "none";
    if (job.lastFiredAt !== void 0 && job.lastFiredAt >= matchedMinuteMs) {
      return "none";
    }
    job.lastFiredAt = matchedMinuteMs;
    const expired = job.recurring && currentMs >= job.expiresAt;
    if (!job.recurring || expired) {
      this.jobs.delete(job.id);
    }
    if (!job.recurring && job.durable && job.sessionMode === "per_run") {
      this.consumedPerRunOneShots.add(job.id);
      const snapshot = this.restorablePerRunOneShots.get(job.id);
      if (snapshot) {
        snapshot.task = { ...snapshot.task, lastFiredAt: matchedMinuteMs };
      }
    }
    if (this.onFire) {
      this.onFire(job);
    }
    return expired ? "fired-final" : "fired";
  }
  /**
   * Returns a human-readable summary of active session-only jobs for
   * display on session exit. Durable jobs are not included since they
   * persist. Returns null if there are no session-only jobs.
   */
  getExitSummary() {
    const sessionJobs = [...this.jobs.values()].filter((job) => !job.durable);
    const wakeups = [...this.wakeups.values()];
    if (sessionJobs.length === 0 && wakeups.length === 0) return null;
    const count = sessionJobs.length + wakeups.length;
    const lines = [
      `Session ending. ${count} active loop${count === 1 ? "" : "s"} cancelled:`
    ];
    for (const job of sessionJobs) {
      const schedule = humanReadableCron(job.cronExpr);
      lines.push(`  - [${job.id}] ${schedule}: ${truncatePrompt(job.prompt)}`);
    }
    for (const wakeup of wakeups) {
      lines.push(
        `  - [${wakeup.id}] wakeup at ${new Date(
          wakeup.fireAtMs
        ).toISOString()}: ${truncatePrompt(wakeup.prompt)}`
      );
    }
    return lines.join("\n");
  }
  /**
   * Clears all jobs and stops the scheduler.
   */
  destroy() {
    this.stop();
    this.jobs.clear();
    this.wakeups.clear();
    this.wakeupChainStartedAt = null;
    this.pendingRemoval.clear();
    this.pendingAdd.clear();
  }
};
function buildMissedCronNotification(missed) {
  const plural = missed.length > 1;
  const header = `The following one-shot scheduled task${plural ? "s were" : " was"} missed while Qwen Code was not running. ${plural ? "They have" : "It has"} been removed from ${CRON_TASKS_DISPLAY_PATH} and will not fire again.

Do NOT execute ${plural ? "these prompts" : "this prompt"} yet. First ask the user whether to run ${plural ? "each one" : "it"} now (use the ${ToolNames.ASK_USER_QUESTION} tool if available). Only execute if the user confirms.`;
  const blocks = missed.map((task) => {
    const meta = `[${humanReadableCron(task.cron)}, created ${new Date(task.createdAt).toLocaleString()}]`;
    const longestRun = (task.prompt.match(/`+/g) ?? []).reduce(
      (max, run) => Math.max(max, run.length),
      0
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${meta}
${fence}
${task.prompt}
${fence}`;
  });
  return `${header}

${blocks.join("\n\n")}`;
}
__name(buildMissedCronNotification, "buildMissedCronNotification");
function hasParseableCron(task) {
  try {
    parseCron(task.cron);
    return true;
  } catch {
    return false;
  }
}
__name(hasParseableCron, "hasParseableCron");
function durableTaskToJob(task, recurringMaxAgeMs, existing) {
  const jitterMs = existing && existing.cronExpr === task.cron && existing.recurring === task.recurring ? existing.jitterMs : computeJitter(task.id, task.cron, task.recurring);
  return {
    id: task.id,
    cronExpr: task.cron,
    prompt: task.prompt,
    recurring: task.recurring,
    createdAt: task.createdAt,
    expiresAt: task.recurring ? task.createdAt + recurringMaxAgeMs : Infinity,
    lastFiredAt: task.lastFiredAt ?? void 0,
    jitterMs,
    durable: true,
    ...task.sessionId ? { boundSessionId: task.sessionId } : {},
    ...task.sessionMode ? { sessionMode: task.sessionMode } : {},
    ...task.modelServiceId ? { modelServiceId: task.modelServiceId } : {},
    ...task.groupId ? { groupId: task.groupId } : {},
    ...task.name ? { name: task.name } : {},
    ...task.delivery && task.sessionId ? { delivery: task.delivery } : {}
  };
}
__name(durableTaskToJob, "durableTaskToJob");
function jobToDurableTask(job) {
  return {
    id: job.id,
    cron: job.cronExpr,
    prompt: job.prompt,
    recurring: job.recurring,
    createdAt: job.createdAt,
    lastFiredAt: job.lastFiredAt ?? null,
    ...job.boundSessionId ? { sessionId: job.boundSessionId } : {},
    ...job.sessionMode ? { sessionMode: job.sessionMode } : {},
    ...job.name ? { name: job.name } : {},
    ...job.delivery ? { delivery: job.delivery } : {}
  };
}
__name(jobToDurableTask, "jobToDurableTask");
function computeNextFireMs(cronExpr, afterMs, jitterMs) {
  try {
    const afterDate = new Date(afterMs);
    const next = nextFireTime(cronExpr, afterDate);
    return next.getTime() + jitterMs;
  } catch {
    return null;
  }
}
__name(computeNextFireMs, "computeNextFireMs");
var nextDurableFireCache = /* @__PURE__ */ new Map();
var NEXT_DURABLE_FIRE_CACHE_MAX = 512;
function nextDurableFireMs(task) {
  const anchor = task.recurring ? task.lastFiredAt ?? task.createdAt : task.createdAt;
  const key = `${task.id}\0${task.cron}\0${task.recurring ? 1 : 0}\0${anchor}`;
  const cached = nextDurableFireCache.get(key);
  if (cached !== void 0) return cached;
  const jitter = computeJitter(task.id, task.cron, task.recurring);
  const result = computeNextFireMs(task.cron, anchor, jitter);
  if (nextDurableFireCache.size >= NEXT_DURABLE_FIRE_CACHE_MAX) {
    nextDurableFireCache.clear();
  }
  nextDurableFireCache.set(key, result);
  return result;
}
__name(nextDurableFireMs, "nextDurableFireMs");

export {
  prepareFileWatchersForProcessExit,
  closeFileWatcher,
  MAX_JOBS,
  DEFAULT_RECURRING_MAX_AGE_DAYS,
  normalizeRecurringMaxAge,
  WAKEUP_MIN_SECONDS,
  WAKEUP_MAX_SECONDS,
  clampWakeupSeconds,
  CronScheduler,
  nextDurableFireMs
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
