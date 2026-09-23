/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Automatic collection of agent-prepared Batch tasks while an interactive
// session is open (and once at startup, which covers tasks submitted before
// the terminal was closed). Deterministic: it reads the local task records,
// polls the provider over plain HTTP and runs the same `collectTask` the CLI
// runs — no model call, so waiting costs nothing. Retries are never
// automatic: they bill again, so the notice only says how.
import fs from 'node:fs';
import path from 'node:path';
import type { BatchEndpoint } from './batch.js';
import {
  BatchTaskStore,
  batchHomeDir,
  isAmbiguous,
  type BatchTask,
} from './batch-task.js';
import {
  collectTask,
  type CollectSummary,
  type WorkflowApi,
} from './batch-workflow.js';
import { SETTLED_STATUSES, getBatchJob } from './batch-client.js';

/** `deliver` collects and writes results; `notify` only says a task is ready. */
export type BatchAutoCollectMode = 'deliver' | 'notify' | 'off';

export interface BatchAutoCollectOptions {
  /** Project root of this session; only its tasks are collected. */
  projectRoot: string;
  mode: BatchAutoCollectMode;
  /** Shows one line in the session (an info notice). */
  notify: (message: string) => void;
  /** Resolved lazily on the first task found; throwing disables polling. */
  resolveEndpoint: () => BatchEndpoint;
  log?: (message: string) => void;
  env?: Record<string, string | undefined>;
  api?: WorkflowApi;
  now?: () => number;
}

// Local scans are cheap (a directory read); provider polls back off per task
// because a batch can queue for hours.
const IDLE_SCAN_MS = 60_000;
const FIRST_POLL_DELAY_MS = 60_000;
const MAX_POLL_DELAY_MS = 5 * 60_000;
const MAX_LISTED = 3;

export interface BatchAutoCollector {
  /** One pass; resolves to the delay before the next pass. */
  tick(): Promise<number>;
  stop(): void;
}

const samePath = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

const isOpen = (task: BatchTask) =>
  task.attempts.some(
    (attempt) =>
      isAmbiguous(attempt) ||
      (attempt.submitState === 'created' &&
        attempt.batchId !== undefined &&
        !attempt.collected),
  );

const list = (names: string[]) =>
  names.slice(0, MAX_LISTED).join(', ') +
  (names.length > MAX_LISTED ? ` and ${names.length - MAX_LISTED} more` : '');

/** One notice line for what a collect changed, or undefined if nothing did. */
export function describeCollect(summary: CollectSummary): string | undefined {
  if (summary.settled === 0 && summary.delivered.length === 0) {
    return undefined;
  }
  const parts = [
    `Batch task ${summary.taskId}: ${summary.delivered.length} result(s) delivered` +
      (summary.delivered.length > 0
        ? ` (${list(summary.delivered.map((item) => item.target))})`
        : ''),
  ];
  if (summary.failed.length > 0) {
    parts.push(
      `${summary.failed.length} failed (${summary.failed[0].lastError ?? 'see collect'})` +
        ` — retry with: qwen batch retry ${summary.taskId}`,
    );
  }
  if (summary.held.length > 0) {
    parts.push(
      `${summary.held.length} held (${summary.held[0].heldReason ?? 'see collect'})` +
        ` — resolve, then: qwen batch collect ${summary.taskId}`,
    );
  }
  if (summary.awaiting > 0) {
    parts.push(`${summary.awaiting} still waiting on the provider`);
  }
  if (summary.jobErrors.length > 0) {
    parts.push(`provider: ${summary.jobErrors[0]}`);
  }
  return parts.join('; ') + '.';
}

export function createBatchAutoCollector(
  options: BatchAutoCollectOptions,
): BatchAutoCollector {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const env = options.env ?? process.env;
  const store = new BatchTaskStore(batchHomeDir(env));
  const nextPollAt = new Map<string, number>();
  const pollDelay = new Map<string, number>();
  // Tasks that can never be collected from this session (another endpoint
  // or key, unreadable record) or were already announced in notify mode.
  const ignored = new Set<string>();
  let endpoint: BatchEndpoint | undefined;
  let disabled = options.mode === 'off';

  const backOff = (id: string) => {
    const delay = Math.min(
      (pollDelay.get(id) ?? FIRST_POLL_DELAY_MS / 2) * 2,
      MAX_POLL_DELAY_MS,
    );
    pollDelay.set(id, delay);
    nextPollAt.set(id, now() + delay);
  };

  const readyInNotifyMode = async (
    ep: BatchEndpoint,
    task: BatchTask,
  ): Promise<boolean> => {
    for (const attempt of task.attempts) {
      if (
        attempt.submitState !== 'created' ||
        !attempt.batchId ||
        attempt.collected
      ) {
        continue;
      }
      const job = await (options.api?.getBatch ?? getBatchJob)(
        ep,
        attempt.batchId,
      );
      if (SETTLED_STATUSES.has(job.status)) return true;
    }
    return false;
  };

  const tick = async (): Promise<number> => {
    if (disabled) return MAX_POLL_DELAY_MS;
    let tasks: BatchTask[];
    try {
      tasks = store
        .list()
        .filter(
          (task) =>
            !ignored.has(task.id) &&
            isOpen(task) &&
            samePath(task.projectRoot, options.projectRoot),
        );
    } catch (error) {
      log(`batch auto-collect: cannot read task records: ${String(error)}`);
      return IDLE_SCAN_MS;
    }
    if (tasks.length === 0) return IDLE_SCAN_MS;

    if (!endpoint) {
      try {
        endpoint = options.resolveEndpoint();
      } catch (error) {
        // No usable Batch credentials in this session: nothing here can be
        // collected, and retrying would only repeat the same failure.
        disabled = true;
        log(`batch auto-collect disabled: ${String(error)}`);
        return MAX_POLL_DELAY_MS;
      }
    }

    for (const task of tasks) {
      if ((nextPollAt.get(task.id) ?? 0) > now()) continue;
      try {
        if (options.mode === 'notify') {
          if (await readyInNotifyMode(endpoint, task)) {
            ignored.add(task.id);
            options.notify(
              `Batch task ${task.id} has finished on the provider. Collect it with: qwen batch collect ${task.id}`,
            );
            continue;
          }
        } else {
          const summary = await collectTask(
            {
              ep: endpoint,
              cwd: task.projectRoot,
              env,
              out: () => {},
              err: (line) => log(`batch auto-collect: ${line}`),
              ...(options.api ? { api: options.api } : {}),
            },
            task.id,
          );
          const notice = describeCollect(summary);
          if (notice) options.notify(notice);
          if (summary.awaiting === 0) {
            nextPollAt.delete(task.id);
            pollDelay.delete(task.id);
            continue;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/was submitted (to|with)/.test(message)) {
          // Pinned to another endpoint or key; the user collects it after
          // switching back. Not an error worth repeating every minute.
          ignored.add(task.id);
        }
        log(`batch auto-collect: ${task.id}: ${message}`);
      }
      backOff(task.id);
    }

    const pending = tasks
      .map((task) => nextPollAt.get(task.id))
      .filter((at): at is number => at !== undefined);
    const soonest = pending.length > 0 ? Math.min(...pending) - now() : 0;
    return Math.max(1_000, Math.min(IDLE_SCAN_MS, soonest || IDLE_SCAN_MS));
  };

  return {
    tick,
    stop: () => {
      disabled = true;
    },
  };
}

/**
 * Start the collector on unref'd timers: first pass immediately (startup
 * catch-up), then as `tick` asks. Never keeps the process alive and never
 * throws into the caller.
 */
export function startBatchAutoCollect(
  options: BatchAutoCollectOptions,
): () => void {
  if (options.mode === 'off') return () => {};
  const collector = createBatchAutoCollector(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = async () => {
    let delay = IDLE_SCAN_MS;
    try {
      delay = await collector.tick();
    } catch (error) {
      options.log?.(`batch auto-collect: ${String(error)}`);
    }
    if (stopped) return;
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };
  void run();
  return () => {
    stopped = true;
    collector.stop();
    if (timer) clearTimeout(timer);
  };
}
