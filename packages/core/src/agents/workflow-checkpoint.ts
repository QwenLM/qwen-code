/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview What a later process needs to know about a run this process
 * started, in case this process exits before the run settles.
 *
 * A run's snapshot is written when it settles, and the registry that knows
 * about it lives only as long as the process. A run whose process is killed,
 * crashes, or is closed mid-run therefore leaves a journal and nothing else:
 * it is missing from `/workflows`, from an ACP client's task list, and from
 * anything that would tell the user it can be resumed.
 *
 * So every run with a journal also writes `<runId>/checkpoint.json` beside it
 * when it registers, and removes it when it settles. A checkpoint that outlives
 * the process that wrote it marks a run that was interrupted. A later process
 * claims it: writes a `failed` snapshot saying so, and removes the checkpoint,
 * after which the run is ordinary history.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isWorkflowSourceRef,
  type WorkflowSourceRef,
} from './workflow-correlation.js';
import {
  getWorkflowTaskMutationKey,
  isWorkflowRunPersistenceActive,
  tryWithWorkflowTaskMutation,
  type WorkflowRunStartMode,
  type WorkflowTask,
} from './workflow-run-registry.js';
import {
  isWorkflowMeta,
  persistWorkflowSnapshot,
  readWorkflowSnapshot,
  snapshotArgs,
  type WorkflowSnapshot,
} from './workflow-snapshot.js';
import { WorkflowJournal } from './runtime/workflow-journal.js';
import type { WorkflowMeta } from './runtime/workflow-sandbox.js';
import { isSymlinkedRoot, isWorkflowRunId } from './runtime/workflow-saved.js';

const debugLogger = createDebugLogger('WORKFLOW_CHECKPOINT');

const CHECKPOINT_FILE = 'checkpoint.json';

/** The error a claimed run's snapshot carries. */
export const INTERRUPTED_WORKFLOW_ERROR =
  'interrupted: the process running this workflow exited before it finished';

/** One run, as its checkpoint records it. */
export interface WorkflowCheckpoint {
  v: 1;
  runId: string;
  /** Session that started the run. A record only; a claim does not read it. */
  sessionId: string;
  /** The process that wrote this, and the machine it ran on. */
  pid: number;
  hostname: string;
  startTime: number;
  /** The source the run executed, so its snapshot can say what ran. */
  script: string;
  scriptPath?: string;
  meta: WorkflowMeta | null;
  description: string;
  workflowName?: string;
  /** The name a name-only session can resume the run by. */
  resumeName?: string;
  sourceRef?: WorkflowSourceRef;
  toolUseId?: string;
  sourceRunId?: string;
  startMode?: WorkflowRunStartMode;
  tokenBudgetTotal: number | null;
  args?: unknown;
  argsOmitted?: true;
  argsRecorded?: true;
}

/** A run a claim found interrupted, with what its notice needs. */
export interface InterruptedWorkflowRun {
  snapshot: WorkflowSnapshot;
  resumeName?: string;
  /** Its journal was there to read, so a resume has something to replay. */
  hasJournal: boolean;
}

/**
 * What a checkpoint needs from a run. A registered `WorkflowTask` satisfies
 * it, and so does the registration the runner is about to hand the registry
 * -- which is what lets a resume record its checkpoint before it registers.
 */
export type WorkflowCheckpointSource = Pick<
  WorkflowTask,
  'runId' | 'startTime'
> &
  Partial<
    Pick<
      WorkflowTask,
      | 'script'
      | 'scriptPath'
      | 'description'
      | 'workflowName'
      | 'resumeName'
      | 'sourceRef'
      | 'toolUseId'
      | 'sourceRunId'
      | 'startMode'
      | 'tokenBudgetTotal'
      | 'args'
    >
  >;

/** The checkpoint for a run about to start, or one already registered. */
export function checkpointFromTask(
  task: WorkflowCheckpointSource,
  context: { sessionId: string; meta: WorkflowMeta | null },
): WorkflowCheckpoint {
  return {
    v: 1,
    runId: task.runId,
    sessionId: context.sessionId,
    pid: process.pid,
    hostname: os.hostname(),
    startTime: task.startTime,
    script: task.script ?? '',
    ...(task.scriptPath ? { scriptPath: task.scriptPath } : {}),
    meta: context.meta,
    description: context.meta?.name ?? task.description ?? task.runId,
    ...(task.workflowName ? { workflowName: task.workflowName } : {}),
    ...(task.resumeName ? { resumeName: task.resumeName } : {}),
    ...(task.sourceRef ? { sourceRef: { ...task.sourceRef } } : {}),
    ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
    ...(task.sourceRunId ? { sourceRunId: task.sourceRunId } : {}),
    ...(task.startMode ? { startMode: task.startMode } : {}),
    tokenBudgetTotal: task.tokenBudgetTotal ?? null,
    ...snapshotArgs(task.args),
  };
}

function checkpointPath(config: Config, runId: string): string | undefined {
  const storage = config.storage;
  if (!storage || !isWorkflowRunId(runId)) return undefined;
  return path.join(
    path.dirname(storage.getWorkflowRunJournalPath(runId)),
    CHECKPOINT_FILE,
  );
}

/** The same refusal the journal makes: never write through a symlinked dir. */
async function isRunDirSymlinked(
  config: Config,
  file: string,
): Promise<boolean> {
  return (
    (await isSymlinkedRoot(config.storage.getWorkflowRunsDir())) ||
    (await isSymlinkedRoot(path.dirname(file)))
  );
}

/**
 * What writing a run's checkpoint did.
 *
 * `unavailable` is not a failure: with no storage, or a run directory reached
 * through a symlink, there is nowhere a checkpoint could live -- and nowhere
 * another process would look for one either.
 */
export type WorkflowCheckpointWrite = 'written' | 'unavailable' | 'failed';

/**
 * Write a run's checkpoint.
 *
 * For a fresh run this is best-effort: without one an interrupted run is only
 * invisible, which is how every run behaved before checkpoints, so a failed
 * write must not fail the run. A resume is the exception -- see the caller in
 * `WorkflowRunner.start` -- which is why the outcome is reported in three
 * parts rather than as a boolean.
 */
export async function writeWorkflowCheckpoint(
  config: Config,
  checkpoint: WorkflowCheckpoint,
): Promise<WorkflowCheckpointWrite> {
  const file = checkpointPath(config, checkpoint.runId);
  if (!file) return 'unavailable';
  try {
    if (await isRunDirSymlinked(config, file)) return 'unavailable';
    await atomicWriteFile(file, JSON.stringify(checkpoint), {
      encoding: 'utf8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
    return 'written';
  } catch (error) {
    debugLogger.warn(
      `writeWorkflowCheckpoint failed for ${checkpoint.runId}: ${error}`,
    );
    return 'failed';
  }
}

/** Remove a run's checkpoint, best-effort. */
export async function removeWorkflowCheckpoint(
  config: Config,
  runId: string,
): Promise<void> {
  const file = checkpointPath(config, runId);
  if (!file) return;
  try {
    if (await isRunDirSymlinked(config, file)) return;
    await fs.rm(file, { force: true });
  } catch (error) {
    debugLogger.warn(`removeWorkflowCheckpoint failed for ${runId}: ${error}`);
  }
}

/** A run's checkpoint, or `undefined` when there is none or it is not one. */
export async function readWorkflowCheckpoint(
  config: Config,
  runId: string,
): Promise<WorkflowCheckpoint | undefined> {
  const file = checkpointPath(config, runId);
  if (!file) return undefined;
  try {
    if (await isRunDirSymlinked(config, file)) return undefined;
    if ((await fs.lstat(file)).isSymbolicLink()) return undefined;
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isWorkflowCheckpoint(parsed) && parsed.runId === runId
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isWorkflowCheckpoint(value: unknown): value is WorkflowCheckpoint {
  if (!isRecord(value)) return false;
  const startMode = value['startMode'];
  const budget = value['tokenBudgetTotal'];
  return (
    value['v'] === 1 &&
    typeof value['runId'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    Number.isSafeInteger(value['pid']) &&
    typeof value['hostname'] === 'string' &&
    typeof value['startTime'] === 'number' &&
    Number.isFinite(value['startTime']) &&
    typeof value['script'] === 'string' &&
    isOptionalString(value['scriptPath']) &&
    isWorkflowMeta(value['meta']) &&
    typeof value['description'] === 'string' &&
    isOptionalString(value['workflowName']) &&
    isOptionalString(value['resumeName']) &&
    (value['sourceRef'] === undefined ||
      isWorkflowSourceRef(value['sourceRef'])) &&
    isOptionalString(value['toolUseId']) &&
    isOptionalString(value['sourceRunId']) &&
    (startMode === undefined ||
      startMode === 'retry' ||
      startMode === 'rerun') &&
    (budget === null ||
      (typeof budget === 'number' && Number.isFinite(budget))) &&
    (value['argsOmitted'] === undefined || value['argsOmitted'] === true) &&
    (value['argsRecorded'] === undefined || value['argsRecorded'] === true)
  );
}

/**
 * Whether a process is running. A process we may not signal is still
 * running; a recycled pid reads as running too, which only delays a claim.
 */
export function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process that wrote this checkpoint is gone. Another machine's process
 * cannot be checked, so its runs are never claimed. A checkpoint with this
 * process's pid passes: whether a session here still has the run is asked of
 * the run, not the pid, by the caller.
 */
function writerHasExited(
  checkpoint: WorkflowCheckpoint,
  isRunning: (pid: number) => boolean,
): boolean {
  if (checkpoint.hostname !== os.hostname()) return false;
  return checkpoint.pid === process.pid || !isRunning(checkpoint.pid);
}

async function lastWriteTime(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function claimOne(
  config: Config,
  seen: WorkflowCheckpoint,
): Promise<InterruptedWorkflowRun | undefined> {
  const { runId } = seen;
  // Read again under the lock. A session here that claimed it first removed
  // it; a resume in another process that started since rewrote it.
  const checkpoint = await readWorkflowCheckpoint(config, runId);
  if (
    !checkpoint ||
    checkpoint.pid !== seen.pid ||
    checkpoint.startTime !== seen.startTime
  ) {
    return undefined;
  }
  // A snapshot from this attempt or a later one means the run settled and
  // only the checkpoint's removal was lost.
  const existing = await readWorkflowSnapshot(config, runId);
  if (existing && existing.startTime >= checkpoint.startTime) {
    await removeWorkflowCheckpoint(config, runId);
    return undefined;
  }
  const storage = config.storage;
  const journalPath = storage.getWorkflowRunJournalPath(runId);
  const loaded = await new WorkflowJournal(
    journalPath,
    storage.getWorkflowRunsDir(),
  ).load();
  const replay = loaded.kind === 'loaded' ? loaded.replay : undefined;
  // The journal is the last thing the run wrote, so its mtime is the closest
  // record of when it stopped.
  const endTime = Math.max(
    checkpoint.startTime,
    (await lastWriteTime(journalPath)) ?? checkpoint.startTime,
  );
  const snapshot: WorkflowSnapshot = {
    runId,
    ...(checkpoint.sourceRef ? { sourceRef: checkpoint.sourceRef } : {}),
    ...(checkpoint.toolUseId ? { toolUseId: checkpoint.toolUseId } : {}),
    description: checkpoint.description,
    ...(checkpoint.workflowName
      ? { workflowName: checkpoint.workflowName }
      : {}),
    ...(checkpoint.sourceRunId ? { sourceRunId: checkpoint.sourceRunId } : {}),
    ...(checkpoint.startMode ? { startMode: checkpoint.startMode } : {}),
    ...(checkpoint.argsOmitted
      ? { argsOmitted: true as const }
      : {
          ...(checkpoint.args !== undefined ? { args: checkpoint.args } : {}),
          ...(checkpoint.argsRecorded ? { argsRecorded: true as const } : {}),
        }),
    meta: checkpoint.meta,
    status: 'failed',
    script: checkpoint.script,
    ...(checkpoint.scriptPath ? { scriptPath: checkpoint.scriptPath } : {}),
    phases: [],
    // What the journal can say: agents that started, and those with a result.
    agentsDispatched: replay?.started.size ?? 0,
    agentsCompleted: replay?.results.size ?? 0,
    tokensSpent: 0,
    tokenBudgetTotal: checkpoint.tokenBudgetTotal,
    perPhaseTokens: [],
    recentLogs: [],
    startTime: checkpoint.startTime,
    endTime,
    error: INTERRUPTED_WORKFLOW_ERROR,
  };
  if (!(await persistWorkflowSnapshot(config, snapshot))) return undefined;
  await removeWorkflowCheckpoint(config, runId);
  return {
    snapshot,
    ...(checkpoint.resumeName ? { resumeName: checkpoint.resumeName } : {}),
    hasJournal: loaded.kind === 'loaded',
  };
}

/**
 * Turn every run whose process exited before it settled into a `failed`
 * snapshot, and return those runs. Runs another process on this machine is
 * still running, and runs any session in this process has, are left alone;
 * sessions of one process that claim at once claim each run once.
 */
export async function claimInterruptedWorkflowRuns(
  config: Config,
  options: { isProcessRunning?: (pid: number) => boolean } = {},
): Promise<InterruptedWorkflowRun[]> {
  const storage = config.storage;
  if (!storage) return [];
  const isRunning = options.isProcessRunning ?? isProcessRunning;
  const runsDir = storage.getWorkflowRunsDir();
  let names: string[];
  try {
    if (await isSymlinkedRoot(runsDir)) return [];
    names = (await fs.readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isWorkflowRunId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const claimed: InterruptedWorkflowRun[] = [];
  for (const runId of names) {
    const run = await claimIfInterrupted(config, runId, isRunning);
    if (run) claimed.push(run);
  }
  claimed.sort((a, b) => b.snapshot.startTime - a.snapshot.startTime);
  return claimed;
}

/**
 * {@link claimInterruptedWorkflowRuns} for one run: turn it into a `failed`
 * snapshot if the process running it exited before it settled, and return
 * it; otherwise leave it alone and return `undefined`. For a caller about to
 * act on one run from its history, whose snapshot is otherwise older than
 * the attempt that was interrupted. An id that is not a run id has no
 * checkpoint path, so nothing is read for it.
 */
export async function claimInterruptedWorkflowRun(
  config: Config,
  runId: string,
  options: { isProcessRunning?: (pid: number) => boolean } = {},
): Promise<InterruptedWorkflowRun | undefined> {
  return claimIfInterrupted(
    config,
    runId,
    options.isProcessRunning ?? isProcessRunning,
  );
}

async function claimIfInterrupted(
  config: Config,
  runId: string,
  isRunning: (pid: number) => boolean,
): Promise<InterruptedWorkflowRun | undefined> {
  const seen = await readWorkflowCheckpoint(config, runId);
  if (!seen || !writerHasExited(seen, isRunning)) return undefined;
  // A session here has the run, or holds its lock to start a resume of it.
  // Checked with no await before the lock is taken below, and a resume
  // cannot start while it is held.
  if (isWorkflowRunPersistenceActive(config, runId)) return undefined;
  try {
    const attempt = await tryWithWorkflowTaskMutation(
      getWorkflowTaskMutationKey(config, runId),
      () => claimOne(config, seen),
    );
    return attempt.acquired ? attempt.value : undefined;
  } catch (error) {
    debugLogger.warn(`claiming interrupted run ${runId} failed: ${error}`);
    return undefined;
  }
}
