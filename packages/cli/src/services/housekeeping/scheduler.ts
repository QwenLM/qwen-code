/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  Storage,
  type Config,
  createDebugLogger,
  getSubagentsRootDir,
  resolveOpenAILogDir,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { DEFAULT_OPENAI_LOG_RETENTION_DAYS } from '../../config/settingsSchema.js';
import {
  cleanupOldFileHistoryBackups,
  cleanupOldOpenAILogs,
  cleanupOldSubagentTranscripts,
  getCutoffDate,
} from '../../utils/housekeeping/cleanup.js';
import { runThrottledOnce } from '../../utils/housekeeping/throttledOnce.js';
import { msSinceLastInteraction } from '../../utils/housekeeping/lastInteractionAt.js';

const debugLogger = createDebugLogger('HOUSEKEEPING');

// Cadence numbers mirror claude-code's backgroundHousekeeping.ts so the
// REPL-typing experience stays in the same regime users may already know.
const STARTUP_DELAY_MS = 10 * 60 * 1000;
const RECURRING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECENT_INTERACTION_MS = 60 * 1000;

// Catch-up: if the marker is older than this, the user has either not run
// qwen for a while or every session has been < 10 min — either way we have
// a backlog to sweep, so shorten the first-pass delay. 7 days is "long
// enough that occasional short sessions don't trigger it, short enough that
// the typical sporadic user still gets periodic cleanup".
const CATCHUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_CATCHUP_MS = 60 * 1000;
const NON_INTERACTIVE_LOCK_RETRY_MS = 60 * 1000;
const NON_INTERACTIVE_FAILURE_RETRY_MS = 10 * 60 * 1000;
const NON_INTERACTIVE_STOP_GRACE_MS = 250;

const FILE_HISTORY_MARKER = '.file-history-cleanup';
const SUBAGENT_MARKER = '.subagent-cleanup';
const OPENAI_LOGS_MARKER = '.openai-logs-cleanup';

let started = false;

interface NonInteractiveOpenAILogJob {
  target: OpenAILogCleanupTarget;
  markerPath: string;
  queued: boolean;
  timer?: NodeJS.Timeout;
}

const nonInteractiveJobs = new Map<string, NonInteractiveOpenAILogJob>();
const nonInteractiveQueue: NonInteractiveOpenAILogJob[] = [];
let activeNonInteractiveJob: NonInteractiveOpenAILogJob | undefined;
let activeNonInteractiveAbortController: AbortController | undefined;
let nonInteractiveWorker: Promise<void> | undefined;
let nonInteractiveStopping = false;
let nonInteractiveStopPromise: Promise<void> | undefined;

export function startBackgroundHousekeeping(
  config: Config,
  settings: LoadedSettings,
): void {
  if (started) return;
  started = true;
  void scheduleFirstPass(config, settings).catch((err) => {
    // Defense in depth: if scheduleFirstPass rejects (currently it can't —
    // its only await is wrapped in needsCatchUp's try/catch — but future
    // edits could regress that), reset `started` so a subsequent call has
    // a chance to bootstrap the chain instead of dying silently for the
    // entire process lifetime.
    started = false;
    debugLogger.error(
      'scheduleFirstPass failed; chain will retry on next start',
      err,
    );
  });
}

async function scheduleFirstPass(
  config: Config,
  settings: LoadedSettings,
): Promise<void> {
  const delay = await getFirstPassDelay(config, settings);
  debugLogger.debug(`first pass in ${delay / 1000}s`);
  setTimeout(() => scheduleNextPass(config, settings), delay).unref();
}

async function getFirstPassDelay(
  config: Config,
  settings: LoadedSettings,
): Promise<number> {
  const qwenDir = Storage.getGlobalQwenDir();
  const markerPaths = [join(qwenDir, FILE_HISTORY_MARKER)];
  const openaiTarget = getOpenAILogCleanupTarget(config, settings);
  if (openaiTarget) {
    markerPaths.push(getOpenAILogsMarkerPath(qwenDir, openaiTarget.logDir));
  }
  const catchUpStates = await Promise.all(markerPaths.map(needsCatchUp));
  return catchUpStates.some(Boolean)
    ? STARTUP_DELAY_CATCHUP_MS
    : STARTUP_DELAY_MS;
}

async function needsCatchUp(markerPath: string): Promise<boolean> {
  try {
    const s = await stat(markerPath);
    return Date.now() - s.mtimeMs > CATCHUP_THRESHOLD_MS;
  } catch {
    return true;
  }
}

function getSubagentMarkerPath(qwenDir: string, projectDir: string): string {
  const projectKey = createHash('sha256')
    .update(projectDir)
    .digest('hex')
    .slice(0, 16);
  return join(qwenDir, `${SUBAGENT_MARKER}-${projectKey}`);
}

// OpenAI logs live per-CWD by default but become a single shared dir when
// openAILoggingDir is configured — key the marker on the resolved log dir
// so both layouts throttle correctly.
function getOpenAILogsMarkerPath(qwenDir: string, logDir: string): string {
  const logDirKey = createHash('sha256')
    .update(logDir)
    .digest('hex')
    .slice(0, 16);
  return join(qwenDir, `${OPENAI_LOGS_MARKER}-${logDirKey}`);
}

interface OpenAILogCleanupTarget {
  logDir: string;
  retentionDays: number;
}

function getOpenAILogCleanupTarget(
  config: Config,
  settings: LoadedSettings,
): OpenAILogCleanupTarget | undefined {
  try {
    const customLogDir =
      config.getContentGeneratorConfig?.()?.openAILoggingDir ??
      config.getModelsConfig?.()?.getGenerationConfig?.().openAILoggingDir ??
      settings.merged.model?.openAILoggingDir;
    const systemRetention =
      settings.system?.settings.model?.openAILogRetentionDays;
    const workspaceRetention = settings.isTrusted
      ? settings.workspace?.settings.model?.openAILogRetentionDays
      : undefined;
    if (
      customLogDir &&
      workspaceRetention !== undefined &&
      systemRetention === undefined
    ) {
      debugLogger.error(
        'workspace-scoped openAILogRetentionDays is unsafe with a custom openAILoggingDir; skipping cleanup',
      );
      return undefined;
    }
    const retentionDays = customLogDir
      ? (systemRetention ??
        settings.user?.settings.model?.openAILogRetentionDays ??
        settings.systemDefaults?.settings.model?.openAILogRetentionDays ??
        DEFAULT_OPENAI_LOG_RETENTION_DAYS)
      : (settings.merged.model?.openAILogRetentionDays ??
        DEFAULT_OPENAI_LOG_RETENTION_DAYS);
    return {
      logDir: resolveOpenAILogDir(customLogDir, config.getWorkingDir()),
      retentionDays,
    };
  } catch (err) {
    debugLogger.error(
      'failed to resolve OpenAI log cleanup target; skipping',
      err,
    );
    return undefined;
  }
}

export function startNonInteractiveOpenAILogHousekeeping(
  config: Config,
  settings: LoadedSettings,
): void {
  if (nonInteractiveStopping) return;

  try {
    const target = getOpenAILogCleanupTarget(config, settings);
    if (!target || nonInteractiveJobs.has(target.logDir)) return;

    const markerPath = getOpenAILogsMarkerPath(
      Storage.getGlobalQwenDir(),
      target.logDir,
    );
    const job: NonInteractiveOpenAILogJob = {
      target,
      markerPath,
      queued: false,
    };
    nonInteractiveJobs.set(target.logDir, job);
    enqueueNonInteractiveJob(job);
  } catch (err) {
    debugLogger.error(
      'failed to start non-interactive OpenAI log cleanup; skipping',
      err,
    );
  }
}

export function stopNonInteractiveOpenAILogHousekeeping(): Promise<void> {
  if (nonInteractiveStopPromise) return nonInteractiveStopPromise;

  nonInteractiveStopping = true;
  for (const job of nonInteractiveJobs.values()) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    job.queued = false;
  }
  nonInteractiveQueue.length = 0;
  activeNonInteractiveAbortController?.abort();

  nonInteractiveStopPromise = waitForNonInteractiveWorkerToStop();
  return nonInteractiveStopPromise;
}

function enqueueNonInteractiveJob(job: NonInteractiveOpenAILogJob): void {
  if (nonInteractiveStopping || job.queued || activeNonInteractiveJob === job) {
    return;
  }

  job.queued = true;
  nonInteractiveQueue.push(job);
  startNonInteractiveWorker();
}

function startNonInteractiveWorker(): void {
  if (nonInteractiveWorker || nonInteractiveStopping) return;

  nonInteractiveWorker = drainNonInteractiveQueue()
    .catch((err) => {
      debugLogger.error('non-interactive OpenAI log worker failed', err);
    })
    .finally(() => {
      nonInteractiveWorker = undefined;
      if (nonInteractiveQueue.length > 0 && !nonInteractiveStopping) {
        startNonInteractiveWorker();
      }
    });
}

async function drainNonInteractiveQueue(): Promise<void> {
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
        abortController.signal,
      );
      if (nonInteractiveStopping) continue;

      switch (result.status) {
        case 'completed':
          scheduleNonInteractiveJob(job, RECURRING_INTERVAL_MS);
          break;
        case 'fresh':
          scheduleNonInteractiveJob(
            job,
            Math.min(
              RECURRING_INTERVAL_MS,
              Math.max(NON_INTERACTIVE_LOCK_RETRY_MS, result.retryAfterMs),
            ),
          );
          break;
        case 'locked':
          scheduleNonInteractiveJob(job, NON_INTERACTIVE_LOCK_RETRY_MS);
          break;
        case 'incomplete':
          break;
        default:
          break;
      }
    } catch (err) {
      debugLogger.error(
        `non-interactive OpenAI log cleanup failed for ${job.target.logDir}`,
        err,
      );
      if (!nonInteractiveStopping) {
        scheduleNonInteractiveJob(job, NON_INTERACTIVE_FAILURE_RETRY_MS);
      }
    } finally {
      activeNonInteractiveJob = undefined;
      activeNonInteractiveAbortController = undefined;
    }
  }
}

async function runOpenAILogCleanup(
  target: OpenAILogCleanupTarget,
  markerPath: string,
  signal?: AbortSignal,
) {
  return runThrottledOnce(
    {
      name: 'openai-logs-cleanup',
      markerPath,
      lockPath: markerPath + '.lock',
    },
    async () => {
      const r = await cleanupOldOpenAILogs({
        logDir: target.logDir,
        cutoffDate: getCutoffDate(target.retentionDays),
        signal,
      });
      debugLogger.debug(
        `openai-logs: removed=${r.removed} errors=${r.errors} completed=${r.completed}`,
      );
      return r.completed ? undefined : false;
    },
  );
}

function scheduleNonInteractiveJob(
  job: NonInteractiveOpenAILogJob,
  delayMs: number,
): void {
  if (nonInteractiveStopping) return;

  job.timer = setTimeout(() => {
    job.timer = undefined;
    enqueueNonInteractiveJob(job);
  }, delayMs);
  job.timer.unref();
}

async function waitForNonInteractiveWorkerToStop(): Promise<void> {
  const worker = nonInteractiveWorker;
  if (!worker) {
    nonInteractiveJobs.clear();
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      worker,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, NON_INTERACTIVE_STOP_GRACE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    nonInteractiveJobs.clear();
  }
}

async function runPass(
  config: Config,
  settings: LoadedSettings,
): Promise<void> {
  if (msSinceLastInteraction() < RECENT_INTERACTION_MS) {
    debugLogger.debug('user active, deferring 10 min');
    setTimeout(
      () => scheduleNextPass(config, settings),
      STARTUP_DELAY_MS,
    ).unref();
    return;
  }
  // Defend the timer chain: if anything in runHousekeeping rejects
  // (eager throws from injected dependencies, ENOSPC/EACCES escaping
  // throttledOnce's writeFile/tryAcquire, etc.), the next pass still
  // gets scheduled so the chain doesn't die permanently. Individual
  // cleaners are already best-effort internally; this catches anything
  // that escapes them.
  try {
    await runHousekeeping(config, settings);
  } catch (err) {
    debugLogger.error('housekeeping pass failed; will retry next cycle', err);
  }
  setTimeout(
    () => scheduleNextPass(config, settings),
    RECURRING_INTERVAL_MS,
  ).unref();
}

// Wrap runPass invocations with a top-level catch so the timer's promise is
// never returned unhandled. runPass already try/catches runHousekeeping, but
// any unexpected throw outside that boundary (e.g., msSinceLastInteraction
// throwing from a corrupted module state) would otherwise become an
// unhandled rejection — and crash the REPL under Node's default
// `--unhandled-rejections=throw`. Mirrors the .catch() defense in
// startBackgroundHousekeeping → scheduleFirstPass.
function scheduleNextPass(config: Config, settings: LoadedSettings): void {
  void runPass(config, settings).catch((err) => {
    debugLogger.error('runPass rejected unexpectedly', err);
  });
}

// Serial pipeline of cleanup tasks. Future cleaners (image cache, paste
// store) get added here as additional runThrottledOnce calls — no
// other plumbing needed.
async function runHousekeeping(
  config: Config,
  settings: LoadedSettings,
): Promise<void> {
  const days = settings.merged.general?.cleanupPeriodDays ?? 30;
  const cutoff = getCutoffDate(days);
  // Lazy read: after /clear the sessionId changes, and we want the *current*
  // session's dir whitelisted, not whichever one was active at scheduler boot.
  //
  // If /clear fires DURING this pass (between this read and the rm calls),
  // the previously-current session becomes a normal orphan: its dir is
  // already protected for this pass via excludeSessionIds, and it will be
  // swept on a future cycle once its mtime ages past cutoff. The newly
  // active session uses a brand-new sessionId/dir, so it's never aliased
  // against any sweep target. Not a bug — slightly conservative is fine.
  const currentSessionId = config.getSessionId();
  const qwenDir = Storage.getGlobalQwenDir();

  await runThrottledOnce(
    {
      name: 'file-history-cleanup',
      markerPath: join(qwenDir, FILE_HISTORY_MARKER),
      lockPath: join(qwenDir, FILE_HISTORY_MARKER + '.lock'),
    },
    async () => {
      const r = await cleanupOldFileHistoryBackups({
        cutoffDate: cutoff,
        excludeSessionIds: new Set([currentSessionId]),
      });
      debugLogger.debug(
        `file-history: removed=${r.removed} errors=${r.errors}`,
      );
    },
  );

  // Subagent transcripts live per-project under <projectDir>/subagents/.
  // Throttle per-project without writing marker dotfiles into the user's
  // checkout. Guard the access: real Config always exposes storage; the
  // optional chain keeps housekeeping best-effort if a caller doesn't.
  const projectDir = config.storage?.getProjectDir?.();
  if (projectDir) {
    const markerPath = getSubagentMarkerPath(qwenDir, projectDir);
    await runThrottledOnce(
      {
        name: 'subagent-cleanup',
        markerPath,
        lockPath: markerPath + '.lock',
      },
      async () => {
        const r = await cleanupOldSubagentTranscripts({
          cutoffDate: cutoff,
          excludeSessionIds: new Set([currentSessionId]),
          subagentsRoot: getSubagentsRootDir(projectDir),
        });
        debugLogger.debug(`subagents: removed=${r.removed} errors=${r.errors}`);
      },
    );
  }

  // Sweeps even when enableOpenAILogging is currently off, so residue from
  // earlier debugging sessions still gets cleaned up. The cutoff uses its
  // own retention setting: these logs grow far faster than file-history
  // backups (one JSON file per API call), so sharing cleanupPeriodDays'
  // 30-day default would retain tens of GB for heavy users.
  const openaiTarget = getOpenAILogCleanupTarget(config, settings);
  if (openaiTarget) {
    await runOpenAILogCleanup(
      openaiTarget,
      getOpenAILogsMarkerPath(qwenDir, openaiTarget.logDir),
    );
  }
}

// Test-only exports — individual underscore-prefixed names matching the
// `_resetForTesting` / `_xxxForTesting` convention used elsewhere in the
// codebase (see lastInteractionAt.ts:_resetForTesting and the 8+ other
// callsites for the pattern).
export function _resetForTesting(): void {
  started = false;
}
export async function _resetNonInteractiveForTesting(): Promise<void> {
  nonInteractiveStopping = true;
  for (const job of nonInteractiveJobs.values()) {
    if (job.timer) clearTimeout(job.timer);
  }
  nonInteractiveQueue.length = 0;
  activeNonInteractiveAbortController?.abort();
  await nonInteractiveWorker;

  nonInteractiveJobs.clear();
  activeNonInteractiveJob = undefined;
  activeNonInteractiveAbortController = undefined;
  nonInteractiveWorker = undefined;
  nonInteractiveStopping = false;
  nonInteractiveStopPromise = undefined;
}
export const _needsCatchUpForTesting = needsCatchUp;
export const _getFirstPassDelayForTesting = getFirstPassDelay;
export const _runHousekeepingForTesting = runHousekeeping;
export const _runPassForTesting = runPass;
export const _FILE_HISTORY_MARKER_FOR_TESTING = FILE_HISTORY_MARKER;
export const _getSubagentMarkerPathForTesting = getSubagentMarkerPath;
export const _getOpenAILogsMarkerPathForTesting = getOpenAILogsMarkerPath;
