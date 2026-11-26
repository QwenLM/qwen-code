/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cron core module — pure SDK layer for scheduling prompts.
 *
 * Public API:
 *   - cron-parser: parseCronExpression, computeNextCronRun, cronToHuman
 *   - cron-tasks: file-store CRUD, SessionCronTaskStore, jitter helpers,
 *     missed-task detection
 *   - cron-scheduler: createCronScheduler factory + lifecycle
 *   - cron-fire-registry: the per-session parked-fire registry and prompt-cache
 *     clock, owned by CronManager
 *   - cronManager: the per-session scheduler, wakeup timer and task
 *     store. `Config` owns one; reach it via `config.getCronManager()`.
 *
 * There is deliberately no module-level lifecycle entry point here. Everything
 * that used to be one (`ensureSchedulerStarted`, `scheduleWakeup`,
 * `getSessionOwnerInfo`, the session task store) named no session and therefore
 * picked whichever session happened to get there first — see the header of
 * cronManager.ts.
 *
 * Note: CronCreate/Delete/List *tools* are registered separately via the
 * tool registry (see `src/tools/cron-create.ts` etc.) and intentionally
 * NOT re-exported from this barrel — they depend on the full tool
 * infrastructure which is a layer above pure SDK.
 */

export {
  type CronFields,
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from './cron-parser.js';

export {
  type CronTask,
  type CronJitterConfig,
  DEFAULT_CRON_JITTER_CONFIG,
  SessionCronTaskStore,
  getCronFilePath,
  readCronTasks,
  writeCronTasks,
  hasCronTasksSync,
  countCronTasksSync,
  buildCronTask,
  appendCronTask,
  applyCronTaskUpdate,
  removeCronTasks,
  claimCronTask,
  markCronTasksFired,
  updateCronTaskExpiry,
  updateCronTask,
  addCronTaskCredits,
  nextCronRunMs,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  findMissedTasks,
} from './cron-tasks.js';

export {
  type CronScheduler,
  type CronSchedulerOptions,
  createCronScheduler,
  isRecurringTaskAged,
  buildMissedTaskNotification,
} from './cron-scheduler.js';

export {
  type CronFireSink,
  type PendingCronFire,
  CronFireRegistry,
} from './cron-fire-registry.js';

export {
  type CronOwnerFingerprint,
  type EnsureCronSchedulerOptions,
  type LoopStatus,
  type ScheduleWakeupResult,
  type CronManagerHost,
  CronManager,
  buildOwnerFingerprint,
} from './cronManager.js';

export {
  registerUserActivityClock,
  readUserActivityClock,
} from './user-activity-clock.js';
