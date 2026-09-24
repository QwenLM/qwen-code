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
import crypto from 'node:crypto';
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
import { isInsideRoot } from './batch-docs.js';

/** `deliver` collects and writes results; `notify` only says a task is ready. */
export type BatchAutoCollectMode = 'deliver' | 'notify' | 'off';

export interface BatchAutoCollectOptions {
  /** Project root of this session; only its tasks are collected. */
  projectRoot: string;
  mode: BatchAutoCollectMode;
  /** Shows one line in the session (an info notice). */
  notify: (message: string) => void;
  /** Resolved on each pass that has a task due; throwing postpones polling
   * (and says so once). */
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
}

const realPath = (p: string) => {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  // Windows paths compare case-insensitively (`c:\` vs `C:\`).
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The task belongs to this session: its root is the session root or below
 * it (the agent's shell may have run `qwen batch run` from a subdirectory). */
const belongsTo = (sessionRoot: string, taskRoot: string) =>
  isInsideRoot(realPath(sessionRoot), realPath(taskRoot));

const isOpen = (task: BatchTask) =>
  task.attempts.some(
    (attempt) =>
      isAmbiguous(attempt) ||
      (attempt.submitState === 'created' &&
        attempt.batchId !== undefined &&
        !attempt.collected),
  );

const endpointKey = (ep: BatchEndpoint) =>
  `${ep.baseUrl} ${crypto.createHash('sha256').update(ep.apiKey).digest('hex').slice(0, 12)}`;

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
  // Batches already announced in notify mode; a later retry's new batch
  // is announced again.
  const announced = new Set<string>();
  // One-time warnings: a submission that cannot be reconciled, and a
  // session that cannot reach the Batch API at all.
  const warnedAmbiguous = new Set<string>();
  let warnedNoEndpoint = false;
  let nextResolveAt = 0;

  const backOff = (id: string) => {
    const delay = Math.min(
      (pollDelay.get(id) ?? FIRST_POLL_DELAY_MS / 2) * 2,
      MAX_POLL_DELAY_MS,
    );
    pollDelay.set(id, delay);
    nextPollAt.set(id, now() + delay);
  };

  const openBatchIds = (task: BatchTask) =>
    task.attempts
      .filter(
        (attempt) =>
          attempt.submitState === 'created' &&
          attempt.batchId !== undefined &&
          !attempt.collected,
      )
      .map((attempt) => attempt.batchId as string);

  const warnIfAmbiguous = (taskId: string) => {
    if (warnedAmbiguous.has(taskId)) return;
    let task: BatchTask;
    try {
      task = store.load(taskId);
    } catch {
      return;
    }
    // Notify mode takes no lock, so an `uploaded` attempt there may be a
    // `run` still submitting; only a recorded lost answer (`unknown`) counts.
    const lost =
      options.mode === 'notify'
        ? task.attempts.some((attempt) => attempt.submitState === 'unknown')
        : task.attempts.some(isAmbiguous);
    if (!lost) return;
    warnedAmbiguous.add(taskId);
    options.notify(
      `Batch task ${taskId} has a submission that could not be matched to a provider batch — it may exist and be billing. ` +
        `Check with: qwen batch collect ${taskId}`,
    );
  };

  const collectOne = async (ep: BatchEndpoint, task: BatchTask) => {
    if (options.mode === 'notify') {
      // Same refusal a collect would give: a batch is only visible to the
      // account and region that created it.
      const key = endpointKey(ep);
      const pinned = task.endpoint
        ? `${task.endpoint.baseUrl} ${task.endpoint.keyFingerprint}`
        : key;
      if (pinned !== key) {
        throw new Error(
          `task ${task.id} was submitted with another endpoint or key`,
        );
      }
      for (const batchId of openBatchIds(task)) {
        if (announced.has(batchId)) continue;
        const job = await (options.api?.getBatch ?? getBatchJob)(ep, batchId);
        if (SETTLED_STATUSES.has(job.status)) {
          announced.add(batchId);
          options.notify(
            `Batch task ${task.id} has finished on the provider. Collect it with: qwen batch collect ${task.id}`,
          );
        }
      }
      return;
    }
    let summary: CollectSummary | undefined;
    try {
      summary = await collectTask(
        {
          ep,
          cwd: task.projectRoot,
          env,
          out: () => {},
          err: (line) => log(`batch auto-collect: ${line}`),
          ...(options.api ? { api: options.api } : {}),
        },
        task.id,
      );
    } catch (error) {
      // A partial collect still reports what it delivered.
      summary = (error as { summary?: CollectSummary }).summary;
      if (!summary) throw error;
      log(`batch auto-collect: ${task.id}: ${String(error)}`);
    }
    const notice = describeCollect(summary);
    if (notice) options.notify(notice);
  };

  const tick = async (): Promise<number> => {
    let tasks: BatchTask[];
    try {
      tasks = store
        .list()
        .filter(
          (task) =>
            isOpen(task) && belongsTo(options.projectRoot, task.projectRoot),
        );
    } catch (error) {
      log(`batch auto-collect: cannot read task records: ${String(error)}`);
      return IDLE_SCAN_MS;
    }
    const due = tasks.filter(
      (task) =>
        (nextPollAt.get(task.id) ?? 0) <= now() &&
        // Already told the user to reconcile by hand; polling it would only
        // page through the provider's batch list every few minutes.
        !warnedAmbiguous.has(task.id) &&
        !(
          options.mode === 'notify' &&
          openBatchIds(task).every((batchId) => announced.has(batchId)) &&
          !task.attempts.some(isAmbiguous)
        ),
    );
    if (due.length > 0 && now() >= nextResolveAt) {
      let ep: BatchEndpoint | undefined;
      try {
        // Resolved per pass, not cached: the user may switch keys or
        // regions mid-session.
        ep = options.resolveEndpoint();
      } catch (error) {
        nextResolveAt = now() + MAX_POLL_DELAY_MS;
        if (!warnedNoEndpoint) {
          warnedNoEndpoint = true;
          options.notify(
            `${tasks.length} /batch-api task(s) of this project cannot be collected automatically: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        log(`batch auto-collect: no endpoint: ${String(error)}`);
      }
      if (ep) {
        for (const task of due) {
          // A task pinned to another endpoint or key is refused like any
          // other failure and simply backs off until the session switches.
          // Only a pass whose reconcile really ran and found nothing may
          // warn "may be billing" — not a lock held by a `run` still
          // submitting, not a transient network error.
          let reconciled = true;
          try {
            await collectOne(ep, task);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            reconciled = /has no submitted batch/.test(message);
            log(`batch auto-collect: ${task.id}: ${message}`);
          }
          if (reconciled) warnIfAmbiguous(task.id);
          backOff(task.id);
        }
      }
    }

    const pending = tasks
      .map((task) => nextPollAt.get(task.id))
      .filter((at): at is number => at !== undefined);
    const soonest = pending.length > 0 ? Math.min(...pending) - now() : 0;
    return Math.max(1_000, Math.min(IDLE_SCAN_MS, soonest || IDLE_SCAN_MS));
  };

  return { tick };
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
    if (timer) clearTimeout(timer);
  };
}
