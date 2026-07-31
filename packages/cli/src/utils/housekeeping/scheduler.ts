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
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  cleanupOldFileHistoryBackups,
  cleanupOldSubagentTranscripts,
  getCutoffDate,
} from './cleanup.js';
import { runThrottledOnce } from './throttledOnce.js';
import { msSinceLastInteraction } from './lastInteractionAt.js';

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

const FILE_HISTORY_MARKER = '.file-history-cleanup';
const SUBAGENT_MARKER = '.subagent-cleanup';

let started = false;

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
  const markerPath = join(Storage.getGlobalQwenDir(), FILE_HISTORY_MARKER);
  const delay = (await needsCatchUp(markerPath))
    ? STARTUP_DELAY_CATCHUP_MS
    : STARTUP_DELAY_MS;
  debugLogger.debug(`first pass in ${delay / 1000}s`);
  setTimeout(() => scheduleNextPass(config, settings), delay).unref();
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

// Serial pipeline of cleanup tasks. Future cleaners (image cache, debug log,
// paste store) get added here as additional runThrottledOnce calls — no
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
}

// Test-only exports — individual underscore-prefixed names matching the
// `_resetForTesting` / `_xxxForTesting` convention used elsewhere in the
// codebase (see lastInteractionAt.ts:_resetForTesting and the 8+ other
// callsites for the pattern).
export function _resetForTesting(): void {
  started = false;
}
export const _needsCatchUpForTesting = needsCatchUp;
export const _runHousekeepingForTesting = runHousekeeping;
export const _runPassForTesting = runPass;
export const _FILE_HISTORY_MARKER_FOR_TESTING = FILE_HISTORY_MARKER;
export const _getSubagentMarkerPathForTesting = getSubagentMarkerPath;
