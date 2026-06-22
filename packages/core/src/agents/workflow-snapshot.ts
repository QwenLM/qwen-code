/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Persisted snapshots of completed workflow runs. The
 * `WorkflowRunRegistry` is in-memory and dies with the CLI process; a
 * snapshot written to `<projectDir>/workflows/<runId>.json` on terminal
 * transition lets `/workflows` show a "recent" history that survives a
 * restart. This is independent of the resume journal (which is per-agent,
 * for caching): a snapshot is the whole-run summary.
 */

import { promises as fs } from 'node:fs';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { WorkflowMeta } from './runtime/workflow-sandbox.js';
import type { WorkflowStatus, WorkflowTask } from './workflow-run-registry.js';

const debugLogger = createDebugLogger('WORKFLOW_SNAPSHOT');

/** Cap on snapshots retained on disk; oldest are pruned on write. */
export const MAX_RETAINED_SNAPSHOTS = 30;

/** JSON-serializable projection of a terminal workflow run. */
export interface WorkflowSnapshot {
  runId: string;
  meta: WorkflowMeta | null;
  status: WorkflowStatus;
  script: string;
  scriptPath?: string;
  phases: string[];
  agentsDispatched: number;
  agentsCompleted: number;
  tokensSpent: number;
  tokenBudgetTotal: number | null;
  /** `perPhaseTokens` flattened to `[phaseOrNull, tokens]` pairs. */
  perPhaseTokens: Array<[string | null, number]>;
  recentLogs: string[];
  startTime: number;
  endTime?: number;
  result?: unknown;
  error?: string;
}

/** Project a (terminal) registry entry into a serializable snapshot. */
export function toSnapshot(task: WorkflowTask): WorkflowSnapshot {
  return {
    runId: task.runId,
    meta: task.meta,
    status: task.status,
    script: task.script ?? '',
    scriptPath: task.scriptPath,
    phases: [...task.phases],
    agentsDispatched: task.agentsDispatched,
    agentsCompleted: task.agentsCompleted,
    tokensSpent: task.tokensSpent,
    tokenBudgetTotal: task.tokenBudgetTotal,
    perPhaseTokens: Array.from(task.perPhaseTokens.entries()),
    recentLogs: [...task.recentLogs],
    startTime: task.startTime,
    endTime: task.endTime,
    result: safeResult(task.result),
    error: task.error,
  };
}

/** A non-JSON-serializable result is replaced with a placeholder string. */
function safeResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  try {
    JSON.stringify(result);
    return result;
  } catch {
    return `(non-JSON-serializable ${typeof result})`;
  }
}

/**
 * Write a run snapshot to `<projectDir>/workflows/<runId>.json`, then prune
 * the oldest snapshots beyond `MAX_RETAINED_SNAPSHOTS`. Best-effort: a write
 * failure is logged, not thrown (persistence is a convenience, not a
 * correctness requirement).
 */
export async function writeWorkflowSnapshot(
  config: Config,
  task: WorkflowTask,
): Promise<void> {
  const storage = config.storage;
  if (!storage) return;
  try {
    const dir = storage.getWorkflowRunsDir();
    await fs.mkdir(dir, { recursive: true });
    const snapshot = toSnapshot(task);
    await fs.writeFile(
      storage.getWorkflowRunSnapshotPath(task.runId),
      JSON.stringify(snapshot, null, 2),
      'utf8',
    );
    await pruneSnapshots(dir);
  } catch (e) {
    debugLogger.warn(`writeWorkflowSnapshot failed for ${task.runId}: ${e}`);
  }
}

/**
 * Load all persisted snapshots, newest-first by `startTime`. Tolerates a
 * missing directory and skips unparseable files.
 */
export async function listWorkflowSnapshots(
  config: Config,
): Promise<WorkflowSnapshot[]> {
  const storage = config.storage;
  if (!storage) return [];
  const dir = storage.getWorkflowRunsDir();
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const snapshots: WorkflowSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(`${dir}/${file}`, 'utf8');
      snapshots.push(JSON.parse(raw) as WorkflowSnapshot);
    } catch (e) {
      debugLogger.warn(`skipping unparseable snapshot ${file}: ${e}`);
    }
  }
  snapshots.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  return snapshots;
}

/** Remove the oldest snapshots beyond the retention cap. */
async function pruneSnapshots(dir: string): Promise<void> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  if (files.length <= MAX_RETAINED_SNAPSHOTS) return;
  // Sort by mtime ascending (oldest first) and unlink the overflow.
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await fs.stat(`${dir}/${f}`);
        return { f, mtime: s.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime);
  const toPrune = stats.slice(0, stats.length - MAX_RETAINED_SNAPSHOTS);
  await Promise.all(
    toPrune.map((s) => {
      // Each run also has a sibling `<runId>/journal.jsonl` directory (the
      // resume journal). Removing only the `<runId>.json` snapshot would leave
      // those journal dirs to grow without bound, so prune both together.
      const runId = s.f.replace(/\.json$/, '');
      return Promise.all([
        fs.unlink(`${dir}/${s.f}`).catch((e) =>
          debugLogger.warn(`prune unlink failed for ${s.f}: ${e}`),
        ),
        fs.rm(`${dir}/${runId}`, { recursive: true, force: true }).catch((e) =>
          debugLogger.warn(`prune journal dir failed for ${runId}: ${e}`),
        ),
      ]);
    }),
  );
}
