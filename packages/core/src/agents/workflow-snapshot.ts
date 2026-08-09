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

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  type Dirent,
  type Stats,
  promises as fs,
  lstatSync,
  realpathSync,
} from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { Storage } from '../config/storage.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { WorkflowMeta } from './runtime/workflow-sandbox.js';
import {
  JOURNAL_FORMAT_VERSION,
  JOURNAL_KEY_VERSION,
  WorkflowJournal,
  type JournalCheckpoint,
} from './runtime/workflow-journal.js';
import {
  isActiveWorkflowStatus,
  isTerminalWorkflowStatus,
  type WorkflowTask,
  type WorkflowStatus,
  type WorkflowTerminalStatus,
} from './workflow-run-registry.js';

const debugLogger = createDebugLogger('WORKFLOW_SNAPSHOT');

/** Cap on snapshots retained on disk; oldest are pruned on write. */
export const MAX_RETAINED_SNAPSHOTS = 30;

export const WORKFLOW_MANIFEST_SCHEMA_VERSION = 2;
export const WORKFLOW_RUNTIME_VERSION = 1;
export const MAX_WORKFLOW_ARGS_BYTES = 64 * 1024;

/**
 * Upper bound on a single manifest/snapshot artifact read into memory.
 * `<projectDir>/workflows` ships with the repository, so a clone can carry a
 * multi-gigabyte `wf_<id>.json`; buffering that aborts the process (heap OOM
 * is not a catchable exception, so the per-entry `catch` that degrades every
 * other malformed artifact to an `invalidRecord` never runs). The bound is
 * far above any real artifact — these are small JSON documents whose largest
 * field is the workflow's own `result`.
 */
export const MAX_WORKFLOW_ARTIFACT_BYTES = 32 * 1024 * 1024;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON-serializable projection of a terminal workflow run. */
export interface WorkflowSnapshot {
  runId: string;
  meta: WorkflowMeta | null;
  status: WorkflowTerminalStatus;
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

export interface WorkflowManifestV2 extends Omit<WorkflowSnapshot, 'status'> {
  schemaVersion: typeof WORKFLOW_MANIFEST_SCHEMA_VERSION;
  runtimeVersion: typeof WORKFLOW_RUNTIME_VERSION;
  status: WorkflowStatus;
  scriptHash: string;
  args?: JsonValue;
  checkpointAt: number;
  journal: JournalCheckpoint;
  canResume: boolean;
  resumeBlockedReason?: string;
}

export interface WorkflowRunRecord extends Omit<WorkflowSnapshot, 'status'> {
  schemaVersion: number;
  runtimeVersion: number;
  status: WorkflowStatus | 'interrupted';
  originalStatus?: WorkflowStatus;
  scriptHash?: string;
  args?: JsonValue;
  checkpointAt?: number;
  journal?: JournalCheckpoint;
  canResume: boolean;
  resumeBlockedReason?: string;
}

export interface WriteWorkflowManifestOptions {
  args: unknown;
  journal: JournalCheckpoint;
  checkpointAt?: number;
  status?: WorkflowStatus;
}

/** Project a (terminal) registry entry into a serializable snapshot. */
export function toSnapshot(task: WorkflowTask): WorkflowSnapshot {
  if (!isTerminalWorkflowStatus(task.status)) {
    throw new Error(`Cannot snapshot active workflow ${task.runId}.`);
  }
  return {
    ...projectTask(task),
    status: task.status,
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

function projectTask(task: WorkflowTask): Omit<WorkflowSnapshot, 'status'> {
  return {
    runId: task.runId,
    meta: task.meta,
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

function hashScript(script: string): string {
  return createHash('sha256').update(script).digest('hex');
}

function cloneJsonArgs(args: unknown): {
  value?: JsonValue;
  reason?: string;
} {
  try {
    const normalized = args === undefined ? null : args;
    const seen = new WeakSet<object>();
    const isJson = (value: unknown): boolean => {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
      ) {
        return true;
      }
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value !== 'object' || seen.has(value)) return false;
      const proto = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        proto !== Object.prototype &&
        proto !== null
      ) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (Array.isArray(value)) {
        if (
          ownKeys.length !== value.length + 1 ||
          !ownKeys.includes('length')
        ) {
          return false;
        }
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) return false;
        }
      } else if (ownKeys.some((key) => typeof key !== 'string')) {
        return false;
      }
      seen.add(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const valid = Object.entries(descriptors).every(
        ([key, descriptor]) =>
          (Array.isArray(value) && key === 'length') ||
          (descriptor.enumerable &&
            'value' in descriptor &&
            isJson(descriptor.value)),
      );
      seen.delete(value);
      return valid;
    };
    if (!isJson(normalized)) {
      return { reason: 'Workflow args are not strictly JSON-serializable.' };
    }
    const serialized = JSON.stringify(normalized);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKFLOW_ARGS_BYTES) {
      return {
        reason: `Workflow args exceed ${MAX_WORKFLOW_ARGS_BYTES} UTF-8 bytes.`,
      };
    }
    return { value: JSON.parse(serialized) as JsonValue };
  } catch {
    return { reason: 'Workflow args are not strictly JSON-serializable.' };
  }
}

function assertRunId(runId: string): void {
  if (!/^wf_[0-9a-f]+$/.test(runId)) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
}

function isLegacyRunId(runId: string): boolean {
  return /^wf_[A-Za-z0-9_-]{1,128}$/.test(runId);
}

function assertLegacyRunId(runId: string): void {
  if (!isLegacyRunId(runId)) {
    throw new Error(`Invalid legacy workflow run id: ${runId}`);
  }
}

function assertSafeArtifactFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`Unsafe workflow artifact symlink: ${filePath}`);
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Unsafe workflow artifact path: ${filePath}`);
  }
}

async function readRegularFileNoFollow(
  filePath: string,
  assertParentUnchanged?: () => void,
): Promise<string> {
  const before = await fs.lstat(filePath);
  assertSafeArtifactFile(before, filePath);
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Unsafe workflow artifact symlink: ${filePath}`);
    }
    throw error;
  }
  try {
    assertParentUnchanged?.();
    const [opened, current] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
    ]);
    assertSafeArtifactFile(opened, filePath);
    assertSafeArtifactFile(current, filePath);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error(`Workflow artifact path changed: ${filePath}`);
    }
    // The size is already in hand from the identity stat; check it before
    // buffering so an oversized artifact degrades to a skipped/invalid record
    // instead of aborting the process on an uncatchable heap OOM.
    if (opened.size > MAX_WORKFLOW_ARTIFACT_BYTES) {
      throw new Error(
        `Workflow artifact is too large: ${filePath} (${opened.size} bytes, limit ${MAX_WORKFLOW_ARTIFACT_BYTES})`,
      );
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

interface DirectoryGuard {
  assertUnchanged(): void;
}

class TerminalSnapshotConflictError extends Error {}

async function guardArtifactTarget(
  filePath: string,
  assertParentUnchanged: () => void,
): Promise<DirectoryGuard> {
  let expected: Stats | undefined;
  try {
    expected = await fs.lstat(filePath);
    assertSafeArtifactFile(expected, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    assertUnchanged(): void {
      assertParentUnchanged();
      let current: Stats | undefined;
      try {
        current = lstatSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!expected && !current) return;
      if (!expected || !current) {
        throw new Error(`Workflow artifact path changed: ${filePath}`);
      }
      assertSafeArtifactFile(current, filePath);
      if (expected.dev !== current.dev || expected.ino !== current.ino) {
        throw new Error(`Workflow artifact path changed: ${filePath}`);
      }
    },
  };
}

async function resolveSafeRunsRoot(
  storage: Storage,
  create: boolean,
): Promise<DirectoryGuard> {
  const root = storage.getWorkflowRunsDir();
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe workflow runs directory: ${root}`);
  }
  const identity = {
    dev: stat.dev,
    ino: stat.ino,
    realPath: await fs.realpath(root),
  };
  return {
    assertUnchanged(): void {
      const current = lstatSync(root);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        realpathSync(root) !== identity.realPath
      ) {
        throw new Error(`Workflow runs directory changed: ${root}`);
      }
    },
  };
}

async function resolveSafeRunDir(
  storage: Storage,
  runId: string,
  create: boolean,
): Promise<DirectoryGuard> {
  assertRunId(runId);
  const root = storage.getWorkflowRunsDir();
  const rootGuard = await resolveSafeRunsRoot(storage, create);
  const runDir = storage.getWorkflowRunDir(runId);
  if (create) {
    await fs.mkdir(runDir, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }
  const runStat = await fs.lstat(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error(`Unsafe workflow run directory: ${runDir}`);
  }
  const [realRoot, realRunDir] = await Promise.all([
    fs.realpath(root),
    fs.realpath(runDir),
  ]);
  if (path.dirname(realRunDir) !== realRoot) {
    throw new Error(`Workflow run directory escapes storage root: ${runDir}`);
  }
  const identity = {
    dev: runStat.dev,
    ino: runStat.ino,
    realPath: realRunDir,
  };
  return {
    assertUnchanged(): void {
      rootGuard.assertUnchanged();
      const current = lstatSync(runDir);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        realpathSync(runDir) !== identity.realPath
      ) {
        throw new Error(`Workflow run directory changed: ${runDir}`);
      }
    },
  };
}

export async function writeWorkflowManifest(
  config: Config,
  task: WorkflowTask,
  options: WriteWorkflowManifestOptions,
): Promise<WorkflowManifestV2 | undefined> {
  const storage = config.storage;
  if (!storage) return undefined;
  const status = options.status ?? task.status;
  const args = cloneJsonArgs(options.args);
  const journal = { ...options.journal };
  const journalReason =
    journal.integrity === 'complete'
      ? undefined
      : (journal.error ?? 'Workflow journal persistence failed.');
  const statusReason = isTerminalWorkflowStatus(status)
    ? `Workflow run is ${status}; terminal runs must be rerun instead of resumed.`
    : undefined;
  const resumeBlockedReason = statusReason ?? args.reason ?? journalReason;
  const manifest: WorkflowManifestV2 = {
    schemaVersion: WORKFLOW_MANIFEST_SCHEMA_VERSION,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    ...projectTask(task),
    status,
    scriptHash: hashScript(task.script ?? ''),
    ...(args.value === undefined ? {} : { args: args.value }),
    checkpointAt: options.checkpointAt ?? Date.now(),
    journal,
    canResume: resumeBlockedReason === undefined,
    ...(resumeBlockedReason ? { resumeBlockedReason } : {}),
  };
  const serialized = JSON.stringify(manifest, null, 2);
  const frozenManifest = JSON.parse(serialized) as WorkflowManifestV2;
  const guard = await resolveSafeRunDir(storage, task.runId, true);
  const manifestPath = storage.getWorkflowRunManifestPath(task.runId);
  const targetGuard = await guardArtifactTarget(
    manifestPath,
    guard.assertUnchanged,
  );
  await atomicWriteFile(manifestPath, serialized, {
    noFollow: true,
    mode: 0o600,
    forceMode: true,
    assertCanCommit: targetGuard.assertUnchanged,
  });
  return frozenManifest;
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
    assertLegacyRunId(task.runId);
    // Project BEFORE the first await: the caller captures this at
    // settlement, but in-flight dispatches keep mutating the live
    // entry across the fs awaits below — a post-await projection
    // froze the snapshot at an fs-timing-dependent point mid-drain.
    const snapshot = toSnapshot(task);
    const serialized = JSON.stringify(snapshot, null, 2);
    const dir = storage.getWorkflowRunsDir();
    const guard = await resolveSafeRunsRoot(storage, true);
    const snapshotPath = storage.getWorkflowRunSnapshotPath(task.runId);
    const targetGuard = await guardArtifactTarget(
      snapshotPath,
      guard.assertUnchanged,
    );
    await atomicWriteFile(snapshotPath, serialized, {
      noFollow: true,
      mode: 0o600,
      forceMode: true,
      assertCanCommit: targetGuard.assertUnchanged,
    });
    await pruneSnapshots(dir, guard.assertUnchanged);
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
  let guard: DirectoryGuard;
  try {
    guard = await resolveSafeRunsRoot(storage, false);
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const snapshots: WorkflowSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = await readRegularFileNoFollow(
        `${dir}/${file}`,
        guard.assertUnchanged,
      );
      snapshots.push(JSON.parse(raw) as WorkflowSnapshot);
    } catch (e) {
      debugLogger.warn(`skipping unparseable snapshot ${file}: ${e}`);
    }
  }
  snapshots.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  return snapshots;
}

function isWorkflowMeta(value: unknown): value is WorkflowMeta | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  if (
    typeof meta['name'] !== 'string' ||
    typeof meta['description'] !== 'string' ||
    (meta['whenToUse'] !== undefined && typeof meta['whenToUse'] !== 'string')
  ) {
    return false;
  }
  return (
    meta['phases'] === undefined ||
    (Array.isArray(meta['phases']) &&
      meta['phases'].every((phase) => {
        if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
          return false;
        }
        const record = phase as Record<string, unknown>;
        return (
          typeof record['title'] === 'string' &&
          (record['detail'] === undefined ||
            typeof record['detail'] === 'string') &&
          (record['model'] === undefined || typeof record['model'] === 'string')
        );
      }))
  );
}

function hasValidPersistedSummary(record: Record<string, unknown>): boolean {
  const nonNegative = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return (
    isWorkflowMeta(record['meta']) &&
    typeof record['script'] === 'string' &&
    (record['scriptPath'] === undefined ||
      typeof record['scriptPath'] === 'string') &&
    Array.isArray(record['phases']) &&
    record['phases'].every((phase) => typeof phase === 'string') &&
    Number.isSafeInteger(record['agentsDispatched']) &&
    nonNegative(record['agentsDispatched']) &&
    Number.isSafeInteger(record['agentsCompleted']) &&
    nonNegative(record['agentsCompleted']) &&
    nonNegative(record['tokensSpent']) &&
    (record['tokenBudgetTotal'] === null ||
      nonNegative(record['tokenBudgetTotal'])) &&
    Array.isArray(record['perPhaseTokens']) &&
    record['perPhaseTokens'].every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        (entry[0] === null || typeof entry[0] === 'string') &&
        nonNegative(entry[1]),
    ) &&
    Array.isArray(record['recentLogs']) &&
    record['recentLogs'].every((line) => typeof line === 'string') &&
    nonNegative(record['startTime']) &&
    (record['endTime'] === undefined || nonNegative(record['endTime'])) &&
    (record['error'] === undefined || typeof record['error'] === 'string')
  );
}

function parseLegacySnapshot(
  value: unknown,
  expectedRunId: string,
): WorkflowSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Legacy workflow snapshot must be a JSON object.');
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot['runId'] !== expectedRunId ||
    !isTerminalWorkflowStatus(snapshot['status'] as WorkflowStatus) ||
    !hasValidPersistedSummary(snapshot)
  ) {
    throw new Error('Legacy workflow snapshot has an invalid shape.');
  }
  return snapshot as unknown as WorkflowSnapshot;
}

function parseManifest(
  value: unknown,
  expectedRunId: string,
): WorkflowManifestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow manifest must be a JSON object.');
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest['schemaVersion'] !== WORKFLOW_MANIFEST_SCHEMA_VERSION ||
    manifest['runtimeVersion'] !== WORKFLOW_RUNTIME_VERSION
  ) {
    throw new Error('Unsupported workflow manifest version.');
  }
  if (manifest['runId'] !== expectedRunId) {
    throw new Error('Workflow manifest run id does not match its directory.');
  }
  const status = manifest['status'];
  if (
    ![
      'running',
      'pausing',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ].includes(String(status))
  ) {
    throw new Error('Workflow manifest has an invalid status.');
  }
  if (
    typeof manifest['script'] !== 'string' ||
    manifest['scriptHash'] !== hashScript(manifest['script'])
  ) {
    throw new Error('Workflow manifest script hash mismatch.');
  }
  const journal = manifest['journal'] as Record<string, unknown> | undefined;
  if (
    !journal ||
    journal['version'] !== JOURNAL_FORMAT_VERSION ||
    journal['keyVersion'] !== JOURNAL_KEY_VERSION ||
    !Number.isSafeInteger(journal['byteLength']) ||
    (journal['byteLength'] as number) < 0 ||
    typeof journal['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(journal['sha256']) ||
    !['complete', 'failed'].includes(String(journal['integrity']))
  ) {
    throw new Error('Workflow manifest has invalid journal metadata.');
  }
  if (
    typeof manifest['canResume'] !== 'boolean' ||
    typeof manifest['checkpointAt'] !== 'number' ||
    !Number.isFinite(manifest['checkpointAt']) ||
    !hasValidPersistedSummary(manifest)
  ) {
    throw new Error('Workflow manifest has invalid checkpoint metadata.');
  }
  if (
    manifest['canResume'] &&
    (journal['integrity'] !== 'complete' ||
      !Object.hasOwn(manifest, 'args') ||
      isTerminalWorkflowStatus(status as WorkflowStatus) ||
      manifest['resumeBlockedReason'] !== undefined)
  ) {
    throw new Error('Workflow manifest resume metadata is incomplete.');
  }
  if (
    !manifest['canResume'] &&
    typeof manifest['resumeBlockedReason'] !== 'string'
  ) {
    throw new Error('Workflow manifest lacks a resume-blocked reason.');
  }
  if (
    manifest['resumeBlockedReason'] !== undefined &&
    typeof manifest['resumeBlockedReason'] !== 'string'
  ) {
    throw new Error('Workflow manifest has an invalid resume-blocked reason.');
  }
  if (
    Object.hasOwn(manifest, 'args') &&
    cloneJsonArgs(manifest['args']).reason
  ) {
    throw new Error('Workflow manifest contains invalid args.');
  }
  return manifest as unknown as WorkflowManifestV2;
}

export async function readWorkflowManifest(
  config: Config,
  runId: string,
): Promise<WorkflowManifestV2> {
  const storage = config.storage;
  if (!storage) throw new Error('Workflow storage is unavailable.');
  const guard = await resolveSafeRunDir(storage, runId, false);
  const manifestPath = storage.getWorkflowRunManifestPath(runId);
  const manifest = parseManifest(
    JSON.parse(
      await readRegularFileNoFollow(manifestPath, guard.assertUnchanged),
    ) as unknown,
    runId,
  );
  const snapshotPath = storage.getWorkflowRunSnapshotPath(runId);
  try {
    const snapshot = parseLegacySnapshot(
      JSON.parse(
        await readRegularFileNoFollow(snapshotPath, guard.assertUnchanged),
      ) as unknown,
      runId,
    );
    if (
      isActiveWorkflowStatus(manifest.status) ||
      snapshot.status !== manifest.status
    ) {
      throw new TerminalSnapshotConflictError(
        `Workflow run ${runId} has a terminal snapshot that conflicts with its manifest.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifest.canResume) {
    await new WorkflowJournal(storage.getWorkflowRunJournalPath(runId)).load(
      manifest.journal,
    );
  }
  return manifest;
}

function invalidRecord(
  runId: string,
  startTime: number,
  reason: string,
): WorkflowRunRecord {
  return {
    runId,
    meta: null,
    status: 'interrupted',
    script: '',
    phases: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    perPhaseTokens: [],
    recentLogs: [],
    startTime,
    schemaVersion: 0,
    runtimeVersion: 0,
    canResume: false,
    resumeBlockedReason: reason,
  };
}

/** Version-aware, read-only workflow history for `/workflows`. */
export async function listWorkflowRunRecords(
  config: Config,
): Promise<WorkflowRunRecord[]> {
  const storage = config.storage;
  if (!storage) return [];
  const byRunId = new Map<string, WorkflowRunRecord>();
  let entries: Dirent[];
  let rootGuard: DirectoryGuard;
  try {
    rootGuard = await resolveSafeRunsRoot(storage, false);
    entries = await fs.readdir(storage.getWorkflowRunsDir(), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const runId = entry.name.slice(0, -'.json'.length);
    if (!isLegacyRunId(runId)) continue;
    const snapshotPath = path.join(storage.getWorkflowRunsDir(), entry.name);
    try {
      if (!entry.isFile()) {
        throw new Error(`Unsafe legacy workflow snapshot: ${snapshotPath}`);
      }
      const snapshot = parseLegacySnapshot(
        JSON.parse(
          await readRegularFileNoFollow(
            snapshotPath,
            rootGuard.assertUnchanged,
          ),
        ) as unknown,
        runId,
      );
      byRunId.set(runId, {
        ...snapshot,
        schemaVersion: 1,
        runtimeVersion: 0,
        canResume: false,
        resumeBlockedReason: 'Legacy workflow snapshots are display-only.',
      });
    } catch (error) {
      const stat = await fs.lstat(snapshotPath).catch(() => undefined);
      byRunId.set(
        runId,
        invalidRecord(
          runId,
          stat?.mtimeMs ?? 0,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  for (const entry of entries) {
    if (!/^wf_[0-9a-f]+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const manifest = await readWorkflowManifest(config, entry.name);
      const legacy = byRunId.get(entry.name);
      if (
        legacy &&
        isTerminalWorkflowStatus(legacy.status as WorkflowStatus) &&
        isActiveWorkflowStatus(manifest.status)
      ) {
        continue;
      }
      byRunId.set(entry.name, {
        ...manifest,
        ...(isActiveWorkflowStatus(manifest.status)
          ? { status: 'interrupted', originalStatus: manifest.status }
          : { status: manifest.status }),
      });
    } catch (error) {
      const legacy = byRunId.get(entry.name);
      if (
        legacy &&
        isTerminalWorkflowStatus(legacy.status as WorkflowStatus) &&
        error instanceof TerminalSnapshotConflictError
      ) {
        continue;
      }
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        byRunId.has(entry.name)
      ) {
        continue;
      }
      const stat = await fs
        .lstat(storage.getWorkflowRunDir(entry.name))
        .catch(() => undefined);
      byRunId.set(
        entry.name,
        invalidRecord(
          entry.name,
          stat?.mtimeMs ?? 0,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return [...byRunId.values()].sort((a, b) => b.startTime - a.startTime);
}

/** Remove the oldest snapshots beyond the retention cap. */
async function pruneSnapshots(
  dir: string,
  assertRootUnchanged: () => void,
): Promise<void> {
  let files: string[];
  try {
    assertRootUnchanged();
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
      // ...but gate the recursive delete on a well-formed run id. The list is a
      // plain `.json` glob, so a file named `...json` yields `runId = ".."` and
      // `fs.rm(`${dir}/..`, {recursive,force})` would delete the runs dir's
      // PARENT; `notarun.json` would delete a sibling `notarun/`. A malicious
      // repo could ship such a file and trip it once pruning kicks in. Only the
      // generated `wf_<hex>` shape (mirrors workflow.ts's resumeFromRunId guard)
      // may drive `fs.rm`. The `.json` unlink stays unconditional — it removes
      // exactly that one file, never a directory.
      const isRunDir = /^wf_[0-9a-f]+$/.test(runId);
      assertRootUnchanged();
      return Promise.all([
        fs
          .unlink(`${dir}/${s.f}`)
          .catch((e) =>
            debugLogger.warn(`prune unlink failed for ${s.f}: ${e}`),
          ),
        ...(isRunDir
          ? [
              fs
                .rm(`${dir}/${runId}`, { recursive: true, force: true })
                .catch((e) =>
                  debugLogger.warn(
                    `prune journal dir failed for ${runId}: ${e}`,
                  ),
                ),
            ]
          : []),
      ]);
    }),
  );
}
