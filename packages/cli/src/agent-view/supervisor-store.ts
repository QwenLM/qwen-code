/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile, Storage } from '@qwen-code/qwen-code-core';
import type {
  AgentViewActivityFile,
  AgentViewCoordinationManifest,
  AgentViewCoordinationManifestAttempt,
  AgentViewCoordinationResult,
  AgentViewLaunchFile,
  AgentViewPtyHostReceipt,
  AgentViewRosterEntry,
  AgentViewRosterFile,
  AgentViewSessionStateFile,
  AgentViewSessionSnapshot,
  AgentViewSupervisorFile,
  AgentViewWorkerFile,
  AgentViewWorkerControlsFile,
} from './protocol.js';

type JsonRecord = Record<string, unknown>;

export interface AgentViewStorePaths {
  globalDir: string;
  daemonDir: string;
  rosterPath: string;
  supervisorPath: string;
  daemonLogPath: string;
  jobsDir: string;
  coordinationsDir: string;
}

export interface AgentViewSessionPaths {
  sessionDir: string;
  statePath: string;
  launchPath: string;
  activityPath: string;
  workerPath: string;
  ptyHostReceiptPath: string;
  controlsPath: string;
  taskPath: string;
  resultPath: string;
  tmpDir: string;
}

export interface AgentViewCoordinationRecord {
  snapshot: AgentViewSessionSnapshot;
  result: AgentViewCoordinationResult | undefined;
}

interface StoreOptions {
  globalDir?: string;
}

const rosterMutationQueues = new Map<string, Promise<void>>();
const sessionMutationQueues = new Map<string, Promise<void>>();

export function getAgentViewStorePaths(
  options: StoreOptions = {},
): AgentViewStorePaths {
  const globalDir = options.globalDir ?? Storage.getGlobalQwenDir();
  const daemonDir = path.join(globalDir, 'daemon');
  return {
    globalDir,
    daemonDir,
    rosterPath: path.join(daemonDir, 'roster.json'),
    supervisorPath: path.join(daemonDir, 'supervisor.json'),
    daemonLogPath: path.join(daemonDir, 'daemon.log'),
    jobsDir: path.join(globalDir, 'jobs'),
    coordinationsDir: path.join(globalDir, 'coordinations'),
  };
}

export function getAgentViewSessionPaths(
  sessionId: string,
  options: StoreOptions = {},
): AgentViewSessionPaths {
  const safeId = sanitizeSessionId(sessionId);
  const sessionDir = path.join(getAgentViewStorePaths(options).jobsDir, safeId);
  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    launchPath: path.join(sessionDir, 'launch.json'),
    activityPath: path.join(sessionDir, 'activity.json'),
    workerPath: path.join(sessionDir, 'worker.json'),
    ptyHostReceiptPath: path.join(sessionDir, 'pty-host.json'),
    controlsPath: path.join(sessionDir, 'controls.json'),
    taskPath: path.join(sessionDir, 'task.md'),
    resultPath: path.join(sessionDir, 'result.json'),
    tmpDir: path.join(sessionDir, 'tmp'),
  };
}

export async function readAgentViewRoster(
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  const raw = await readJsonRecord(getAgentViewStorePaths(options).rosterPath);
  return normalizeRoster(raw);
}

export async function writeAgentViewRoster(
  roster: AgentViewRosterFile,
  options: StoreOptions = {},
): Promise<void> {
  await writeJsonFile(getAgentViewStorePaths(options).rosterPath, roster);
}

export async function upsertAgentViewRosterEntry(
  entry: AgentViewRosterEntry,
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  return mutateAgentViewRoster(options, async () => {
    const roster = await readAgentViewRosterForWrite(options);
    const entryKey = sanitizeSessionId(entry.sessionId);
    const sessions = roster.sessions.filter(
      (item) => sanitizeSessionId(item.sessionId) !== entryKey,
    );
    const existing = roster.sessions.find(
      (item) => sanitizeSessionId(item.sessionId) === entryKey,
    );
    const updated: AgentViewRosterEntry = {
      ...existing,
      ...entry,
    };
    const next: AgentViewRosterFile = {
      ...roster,
      schemaVersion: 1,
      updatedAt: entry.updatedAt,
      sessions: [...sessions, updated].sort(compareRosterEntries),
    };
    await writeAgentViewRoster(next, options);
    return next;
  });
}

export async function removeAgentViewRosterEntry(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  return mutateAgentViewRoster(options, async () => {
    const roster = await readAgentViewRosterForWrite(options);
    const sessionKey = sanitizeSessionId(sessionId);
    const now = new Date().toISOString();
    const next: AgentViewRosterFile = {
      ...roster,
      schemaVersion: 1,
      updatedAt: now,
      sessions: roster.sessions.filter(
        (item) => sanitizeSessionId(item.sessionId) !== sessionKey,
      ),
    };
    await writeAgentViewRoster(next, options);
    return next;
  });
}

export async function updateAgentViewRosterEntry(
  sessionId: string,
  update: (entry: AgentViewRosterEntry) => AgentViewRosterEntry,
  options: StoreOptions = {},
): Promise<AgentViewRosterEntry | undefined> {
  return mutateAgentViewRoster(options, async () => {
    const roster = await readAgentViewRosterForWrite(options);
    const sessionKey = sanitizeSessionId(sessionId);
    const existing = roster.sessions.find(
      (entry) => sanitizeSessionId(entry.sessionId) === sessionKey,
    );
    if (!existing) return undefined;
    const updated = update(existing);
    const sessions = roster.sessions.filter(
      (entry) => sanitizeSessionId(entry.sessionId) !== sessionKey,
    );

    const next: AgentViewRosterFile = {
      ...roster,
      schemaVersion: 1,
      updatedAt: updated.updatedAt,
      sessions: [...sessions, updated].sort(compareRosterEntries),
    };
    await writeAgentViewRoster(next, options);
    return updated;
  });
}

export async function readAgentViewSessionState(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewSessionStateFile | undefined> {
  const raw = await readJsonRecord(
    getAgentViewSessionPaths(sessionId, options).statePath,
  );
  return normalizeSessionState(raw, sessionId);
}

export async function writeAgentViewSessionState(
  state: AgentViewSessionStateFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(state.sessionId, options);
  const existing = await readJsonRecord(paths.statePath);
  await writeJsonFile(paths.statePath, {
    ...existing,
    ...state,
    schemaVersion: 1,
  });
  await fs.mkdir(paths.tmpDir, { recursive: true });
}

export async function listAgentViewSessionStates(
  options: StoreOptions = {},
): Promise<AgentViewSessionStateFile[]> {
  const { jobsDir } = getAgentViewStorePaths(options);
  let entries: string[];
  try {
    entries = await fs.readdir(jobsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const states = await Promise.all(
    entries.map((sessionId) => readAgentViewSessionState(sessionId, options)),
  );
  return states
    .filter((state): state is AgentViewSessionStateFile => Boolean(state))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function listAgentViewSessionSnapshots(
  options: StoreOptions = {},
): Promise<AgentViewSessionSnapshot[]> {
  const states = await listAgentViewSessionStates(options);
  const roster = await readAgentViewRoster(options);
  const rosterEntries = new Map(
    roster.sessions.map((entry) => [entry.sessionId, entry]),
  );
  const snapshots = await Promise.all(
    states.map(async (state) => {
      const [launch, activity, worker, result] = await Promise.all([
        readAgentViewLaunch(state.sessionId, options),
        readAgentViewActivity(state.sessionId, options),
        readAgentViewWorker(state.sessionId, options),
        state.coordination
          ? readAgentViewCoordinationResult(state.sessionId, options)
          : undefined,
      ]);
      return {
        sessionId: state.sessionId,
        state,
        launch: redactAgentViewLaunch(launch),
        activity,
        worker: redactAgentViewWorker(worker),
        rosterEntry: rosterEntries.get(sanitizeSessionId(state.sessionId)),
        ...(result ? { result } : {}),
        ...(activity?.staleReason === 'checkout_changed'
          ? { staleReason: 'checkout_changed' as const }
          : {}),
      };
    }),
  );
  return snapshots.sort((left, right) =>
    right.state.updatedAt.localeCompare(left.state.updatedAt),
  );
}

export async function readAgentViewLaunch(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewLaunchFile | undefined> {
  const raw = await readJsonRecord(
    getAgentViewSessionPaths(sessionId, options).launchPath,
  );
  return normalizeLaunch(raw, sessionId);
}

export async function writeAgentViewLaunch(
  launch: AgentViewLaunchFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(launch.sessionId, options);
  const existing = await readJsonRecord(paths.launchPath);
  await writeJsonFile(paths.launchPath, {
    ...existing,
    ...launch,
    schemaVersion: 1,
  });
}

export async function readAgentViewActivity(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewActivityFile | undefined> {
  const raw = await readJsonRecord(
    getAgentViewSessionPaths(sessionId, options).activityPath,
  );
  return normalizeActivity(raw);
}

export async function writeAgentViewActivity(
  sessionId: string,
  activity: AgentViewActivityFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(sessionId, options);
  const existing = await readJsonRecord(paths.activityPath);
  await writeJsonFile(paths.activityPath, {
    ...existing,
    ...activity,
    schemaVersion: 1,
  });
}

export async function readAgentViewWorker(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewWorkerFile | undefined> {
  const raw = await readJsonRecord(
    getAgentViewSessionPaths(sessionId, options).workerPath,
  );
  return normalizeWorker(raw);
}

export async function writeAgentViewWorker(
  sessionId: string,
  worker: AgentViewWorkerFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(sessionId, options);
  const existing = await readJsonRecord(paths.workerPath);
  await writeJsonFile(paths.workerPath, {
    ...existing,
    ...worker,
    schemaVersion: 1,
  });
}

export async function readAgentViewCoordinationManifest(
  coordinationId: string,
  options: StoreOptions = {},
): Promise<AgentViewCoordinationManifest | undefined> {
  const raw = await readJsonRecord(
    getCoordinationManifestPath(coordinationId, options),
  );
  return normalizeCoordinationManifest(raw, coordinationId);
}

export async function writeAgentViewCoordinationManifest(
  manifest: AgentViewCoordinationManifest,
  options: StoreOptions = {},
): Promise<void> {
  await writeJsonFile(
    getCoordinationManifestPath(manifest.coordinationId, options),
    {
      ...manifest,
    },
  );
}

export async function readAgentViewPtyHostReceipt(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewPtyHostReceipt | undefined> {
  const receiptPath = getAgentViewSessionPaths(
    sessionId,
    options,
  ).ptyHostReceiptPath;
  let stat;
  try {
    stat = await fs.lstat(receiptPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  return normalizePtyHostReceipt(await readJsonRecord(receiptPath), sessionId);
}

export async function writeAgentViewPtyHostReceipt(
  receipt: AgentViewPtyHostReceipt,
  options: StoreOptions = {},
): Promise<void> {
  await writeJsonFile(
    getAgentViewSessionPaths(receipt.sessionId, options).ptyHostReceiptPath,
    { ...receipt },
  );
}

export async function removeAgentViewPtyHostReceipt(
  sessionId: string,
  options: StoreOptions = {},
): Promise<void> {
  await fs
    .unlink(getAgentViewSessionPaths(sessionId, options).ptyHostReceiptPath)
    .catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });
}

export async function readAgentViewWorkerControls(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewWorkerControlsFile> {
  const raw = await readJsonRecord(
    getAgentViewSessionPaths(sessionId, options).controlsPath,
  );
  return normalizeWorkerControls(raw);
}

export async function writeAgentViewWorkerControls(
  sessionId: string,
  controls: AgentViewWorkerControlsFile,
  options: StoreOptions = {},
): Promise<void> {
  await writeJsonFile(
    getAgentViewSessionPaths(sessionId, options).controlsPath,
    controls,
  );
}

export async function writeAgentViewCoordinationTask(
  sessionId: string,
  content: Buffer,
  options: StoreOptions = {},
): Promise<string> {
  const taskPath = getAgentViewSessionPaths(sessionId, options).taskPath;
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await atomicWriteFile(taskPath, content, {
    mode: 0o600,
    forceMode: true,
    noFollow: true,
  });
  return taskPath;
}

export async function writeAgentViewCoordinationResult(
  result: AgentViewCoordinationResult,
  options: StoreOptions = {},
): Promise<void> {
  await writeJsonFile(
    getAgentViewSessionPaths(result.sessionId, options).resultPath,
    { ...result },
  );
}

export async function readAgentViewCoordinationResult(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewCoordinationResult | undefined> {
  return normalizeCoordinationResult(
    await readJsonRecord(
      getAgentViewSessionPaths(sessionId, options).resultPath,
    ),
  );
}

export async function listAgentViewCoordinationRecords(
  coordinationId: string,
  options: StoreOptions = {},
): Promise<AgentViewCoordinationRecord[]> {
  const states = (await listAgentViewSessionStates(options))
    .filter((state) => state.coordination?.coordinationId === coordinationId)
    .sort(compareCoordinationStates);
  return Promise.all(
    states.map(async (state) => ({
      snapshot: {
        sessionId: state.sessionId,
        state,
        launch: await readAgentViewLaunch(state.sessionId, options),
        activity: await readAgentViewActivity(state.sessionId, options),
        worker: await readAgentViewWorker(state.sessionId, options),
      },
      result: await readAgentViewCoordinationResult(state.sessionId, options),
    })),
  );
}

export async function removeAgentViewSessionFiles(
  sessionId: string,
  options: StoreOptions = {},
): Promise<void> {
  await fs.rm(getAgentViewSessionPaths(sessionId, options).sessionDir, {
    recursive: true,
    force: true,
  });
}

export async function withAgentViewSessionMutation<T>(
  sessionId: string,
  options: StoreOptions,
  action: () => Promise<T>,
): Promise<T> {
  const sessionDir = getAgentViewSessionPaths(sessionId, options).sessionDir;
  const previous = sessionMutationQueues.get(sessionDir) ?? Promise.resolve();
  const current = previous.then(action, action);
  const queued = current
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (sessionMutationQueues.get(sessionDir) === queued) {
        sessionMutationQueues.delete(sessionDir);
      }
    });
  sessionMutationQueues.set(sessionDir, queued);
  return current;
}

export async function readAgentViewSupervisor(
  options: StoreOptions = {},
): Promise<AgentViewSupervisorFile | undefined> {
  const raw = await readJsonRecord(
    getAgentViewStorePaths(options).supervisorPath,
  );
  return normalizeSupervisor(raw);
}

export async function writeAgentViewSupervisor(
  supervisor: AgentViewSupervisorFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewStorePaths(options);
  const existing = await readJsonRecord(paths.supervisorPath);
  await writeJsonFile(paths.supervisorPath, {
    ...existing,
    ...supervisor,
    schemaVersion: 1,
  });
}

function sanitizeSessionId(sessionId: string): string {
  const safe = path
    .basename(sessionId.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/^\.+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1F]/g, '_');
  return safe || '_';
}

function compareRosterEntries(
  left: AgentViewRosterEntry,
  right: AgentViewRosterEntry,
): number {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) {
    return left.pinned ? -1 : 1;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

function compareCoordinationStates(
  left: AgentViewSessionStateFile,
  right: AgentViewSessionStateFile,
): number {
  return (
    (left.coordination?.taskId ?? '').localeCompare(
      right.coordination?.taskId ?? '',
    ) ||
    left.createdAt.localeCompare(right.createdAt) ||
    (left.coordination?.attemptId ?? '').localeCompare(
      right.coordination?.attemptId ?? '',
    )
  );
}

async function readJsonRecord(
  filePath: string,
): Promise<JsonRecord | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isNodeError(error) && error.code === 'ENOENT')
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readJsonRecordForWrite(
  filePath: string,
): Promise<JsonRecord | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function readAgentViewRosterForWrite(
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  const raw = await readJsonRecordForWrite(
    getAgentViewStorePaths(options).rosterPath,
  );
  return normalizeRoster(raw);
}

async function mutateAgentViewRoster<T>(
  options: StoreOptions,
  action: () => Promise<T>,
): Promise<T> {
  const rosterPath = getAgentViewStorePaths(options).rosterPath;
  const previous = rosterMutationQueues.get(rosterPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => {}).then(() => gate);
  rosterMutationQueues.set(rosterPath, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (rosterMutationQueues.get(rosterPath) === current) {
      rosterMutationQueues.delete(rosterPath);
    }
  }
}

async function writeJsonFile(
  filePath: string,
  value: JsonRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    forceMode: true,
    noFollow: true,
  });
}

function normalizeRoster(raw: JsonRecord | undefined): AgentViewRosterFile {
  const now = new Date().toISOString();
  const sessions = Array.isArray(raw?.['sessions'])
    ? raw['sessions']
        .map(normalizeRosterEntry)
        .filter((entry): entry is AgentViewRosterEntry => Boolean(entry))
    : [];
  return {
    ...raw,
    schemaVersion: 1,
    updatedAt: stringValue(raw?.['updatedAt']) ?? now,
    sessions: sessions.sort(compareRosterEntries),
  };
}

function normalizeRosterEntry(
  value: unknown,
): AgentViewRosterEntry | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = stringValue(value['sessionId']);
  const projectCwd = stringValue(value['projectCwd']);
  const activeCwd = stringValue(value['activeCwd']);
  const createdAt = stringValue(value['createdAt']);
  const updatedAt = stringValue(value['updatedAt']);
  if (!sessionId || !projectCwd || !activeCwd || !createdAt || !updatedAt) {
    return undefined;
  }
  return {
    ...value,
    sessionId,
    projectCwd: path.resolve(projectCwd),
    activeCwd: path.resolve(activeCwd),
    ...(stringValue(value['displayName'])
      ? { displayName: stringValue(value['displayName']) }
      : {}),
    ...(typeof value['pinned'] === 'boolean'
      ? { pinned: value['pinned'] }
      : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeSessionState(
  raw: JsonRecord | undefined,
  expectedSessionId: string,
): AgentViewSessionStateFile | undefined {
  if (!raw) return undefined;
  const sessionId = stringValue(raw['sessionId']) ?? expectedSessionId;
  const projectCwd = stringValue(raw['projectCwd']);
  const originalCwd = stringValue(raw['originalCwd']);
  const activeCwd = stringValue(raw['activeCwd']);
  const createdAt = stringValue(raw['createdAt']);
  const updatedAt = stringValue(raw['updatedAt']);
  if (
    !sessionId ||
    !projectCwd ||
    !originalCwd ||
    !activeCwd ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  return {
    ...raw,
    schemaVersion: 1,
    sessionId,
    ownership: ownershipValue(raw['ownership']),
    sessionState: sessionStateValue(raw['sessionState']),
    processState: processStateValue(raw['processState']),
    attachState: attachStateValue(raw['attachState']),
    projectCwd: path.resolve(projectCwd),
    originalCwd: path.resolve(originalCwd),
    activeCwd: path.resolve(activeCwd),
    createdAt,
    updatedAt,
    worktree: isRecord(raw['worktree'])
      ? {
          ...raw['worktree'],
          mode: worktreeModeValue(raw['worktree']['mode']),
        }
      : { mode: 'none' },
  };
}

function normalizeLaunch(
  raw: JsonRecord | undefined,
  expectedSessionId: string,
): AgentViewLaunchFile | undefined {
  if (!raw) return undefined;
  const sessionId = stringValue(raw['sessionId']) ?? expectedSessionId;
  const entrypoint = stringValue(raw['entrypoint']);
  const projectCwd = stringValue(raw['projectCwd']);
  const activeCwd = stringValue(raw['activeCwd']);
  if (!sessionId || !entrypoint || !projectCwd || !activeCwd) return undefined;
  return stripUndefined({
    ...raw,
    schemaVersion: 1,
    sessionId,
    argv: stringArrayValue(raw['argv']),
    env: stringMapValue(raw['env']),
    entrypoint,
    initialPrompt: stringValue(raw['initialPrompt']),
    projectCwd: path.resolve(projectCwd),
    activeCwd: path.resolve(activeCwd),
    includeDirectories: stringArrayValue(raw['includeDirectories']),
    terminal: terminalValue(raw['terminal']),
  }) as AgentViewLaunchFile;
}

function redactAgentViewLaunch(
  launch: AgentViewLaunchFile | undefined,
): AgentViewLaunchFile | undefined {
  if (!launch) return undefined;
  return {
    ...launch,
    env: {},
  };
}

function normalizeActivity(
  raw: JsonRecord | undefined,
): AgentViewActivityFile | undefined {
  if (!raw) return undefined;
  const lastActivityAt = stringValue(raw['lastActivityAt']);
  if (!lastActivityAt) return undefined;
  return stripUndefined({
    ...raw,
    schemaVersion: 1,
    summary: stringValue(raw['summary']),
    waitingFor: stringValue(raw['waitingFor']),
    inputKind: inputKindValue(raw['inputKind']),
    lastResult: stringValue(raw['lastResult']),
    activePromptId: stringValue(raw['activePromptId']),
    lastCompletedPromptId: stringValue(raw['lastCompletedPromptId']),
    pendingInput: normalizePendingInput(raw['pendingInput']),
    queuedPromptCount: numberValue(raw['queuedPromptCount']),
    queuedPromptPreview: stringValue(raw['queuedPromptPreview']),
    lastQueuedPromptAt: stringValue(raw['lastQueuedPromptAt']),
    lastActivityAt,
    capabilities: stringArrayValue(raw['capabilities']),
  }) as AgentViewActivityFile;
}

function normalizePendingInput(
  value: unknown,
): AgentViewActivityFile['pendingInput'] {
  if (
    !isRecord(value) ||
    !isPositiveSafeInteger(value['generation']) ||
    typeof value['promptId'] !== 'string' ||
    !value['promptId'] ||
    typeof value['callId'] !== 'string' ||
    !value['callId'] ||
    (value['type'] !== 'tool_confirmation' &&
      value['type'] !== 'ask_user_question') ||
    typeof value['summary'] !== 'string'
  ) {
    return undefined;
  }
  return {
    generation: value['generation'],
    promptId: value['promptId'],
    callId: value['callId'],
    type: value['type'],
    summary: value['summary'],
  };
}

function redactAgentViewWorker(
  worker: AgentViewWorkerFile | undefined,
): AgentViewWorkerFile | undefined {
  if (!worker) return undefined;
  return stripUndefined({
    ...worker,
    hostAuthToken: undefined,
  }) as AgentViewWorkerFile;
}

function stripUndefined(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  );
}

function normalizeWorker(
  raw: JsonRecord | undefined,
): AgentViewWorkerFile | undefined {
  if (!raw) return undefined;
  return stripUndefined({
    ...raw,
    schemaVersion: 1,
    hostPid: numberValue(raw['hostPid']),
    workerPid: numberValue(raw['workerPid']),
    endpoint: stringValue(raw['endpoint']),
    hostEndpoint: stringValue(raw['hostEndpoint']),
    hostAuthToken: stringValue(raw['hostAuthToken']),
    tokenDigest: stringValue(raw['tokenDigest']),
    lastHeartbeatAt: stringValue(raw['lastHeartbeatAt']),
    generation: nonNegativeIntegerValue(raw['generation']),
    lastEventSequence: nonNegativeIntegerValue(raw['lastEventSequence']),
    protocolVersion: numberValue(raw['protocolVersion']) ?? 1,
    platform: platformValue(raw['platform']),
    recentOutputBytes: numberValue(raw['recentOutputBytes']) ?? 0,
  }) as AgentViewWorkerFile;
}

function normalizeCoordinationManifest(
  raw: JsonRecord | undefined,
  coordinationId: string,
): AgentViewCoordinationManifest | undefined {
  if (
    !raw ||
    raw['schemaVersion'] !== 1 ||
    raw['coordinationId'] !== coordinationId ||
    typeof raw['projectCwd'] !== 'string' ||
    typeof raw['createdAt'] !== 'string' ||
    typeof raw['updatedAt'] !== 'string' ||
    !Array.isArray(raw['attempts'])
  ) {
    return undefined;
  }
  const attempts = raw['attempts']
    .map(normalizeCoordinationManifestAttempt)
    .filter(
      (attempt): attempt is AgentViewCoordinationManifestAttempt =>
        attempt !== undefined,
    );
  if (attempts.length !== raw['attempts'].length) return undefined;
  return {
    schemaVersion: 1,
    coordinationId,
    projectCwd: path.resolve(raw['projectCwd']),
    createdAt: raw['createdAt'],
    updatedAt: raw['updatedAt'],
    attempts,
  };
}

function normalizeCoordinationManifestAttempt(
  value: unknown,
): AgentViewCoordinationManifestAttempt | undefined {
  if (!isRecord(value) || !isRecord(value['lineage'])) return undefined;
  const lineage = value['lineage'];
  const worktreePhase = value['worktreePhase'];
  const worktree = value['worktree'];
  if (
    typeof lineage['coordinationId'] !== 'string' ||
    typeof lineage['taskId'] !== 'string' ||
    typeof lineage['attemptId'] !== 'string' ||
    typeof value['sessionId'] !== 'string' ||
    typeof value['promptId'] !== 'string' ||
    (value['writeMode'] !== 'read-only' &&
      value['writeMode'] !== 'isolated-writer') ||
    typeof value['inputSnapshot'] !== 'string' ||
    !value['inputSnapshot'].startsWith('sha256:') ||
    (worktreePhase !== undefined &&
      worktreePhase !== 'planned' &&
      worktreePhase !== 'provisioned' &&
      worktreePhase !== 'launching' &&
      worktreePhase !== 'launched') ||
    (worktreePhase !== undefined &&
      (!isRecord(worktree) ||
        worktree['mode'] !== 'worktree' ||
        typeof worktree['path'] !== 'string' ||
        !path.isAbsolute(worktree['path']) ||
        typeof worktree['slug'] !== 'string' ||
        typeof worktree['branch'] !== 'string' ||
        typeof worktree['baseCommit'] !== 'string' ||
        worktree['owner'] !== 'agent-view'))
  ) {
    return undefined;
  }
  return {
    lineage: {
      coordinationId: lineage['coordinationId'],
      taskId: lineage['taskId'],
      attemptId: lineage['attemptId'],
    },
    sessionId: value['sessionId'],
    promptId: value['promptId'],
    writeMode: value['writeMode'],
    inputSnapshot: value[
      'inputSnapshot'
    ] as AgentViewCoordinationManifestAttempt['inputSnapshot'],
    ...(isRecord(worktree)
      ? {
          worktree: {
            ...worktree,
            mode: worktreeModeValue(worktree['mode']),
          },
        }
      : {}),
    ...(worktreePhase === 'planned' ||
    worktreePhase === 'provisioned' ||
    worktreePhase === 'launching' ||
    worktreePhase === 'launched'
      ? { worktreePhase }
      : {}),
  };
}

function getCoordinationManifestPath(
  coordinationId: string,
  options: StoreOptions,
): string {
  return path.join(
    getAgentViewStorePaths(options).coordinationsDir,
    `${sanitizeSessionId(coordinationId)}.json`,
  );
}

function normalizePtyHostReceipt(
  raw: JsonRecord | undefined,
  sessionId: string,
): AgentViewPtyHostReceipt | undefined {
  if (
    !raw ||
    raw['schemaVersion'] !== 1 ||
    raw['sessionId'] !== sessionId ||
    !isPositiveSafeInteger(raw['hostPid']) ||
    !isPositiveSafeInteger(raw['workerPid']) ||
    typeof raw['hostEndpoint'] !== 'string' ||
    !raw['hostEndpoint'] ||
    typeof raw['hostAuthToken'] !== 'string' ||
    !raw['hostAuthToken'] ||
    !isPositiveSafeInteger(raw['generation'])
  ) {
    return undefined;
  }
  return raw as unknown as AgentViewPtyHostReceipt;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function normalizeWorkerControls(
  raw: JsonRecord | undefined,
): AgentViewWorkerControlsFile {
  const rawEvents = raw?.['events'];
  const events = Array.isArray(rawEvents)
    ? rawEvents.filter(isWorkerControlEvent)
    : [];
  const nextSequence = Math.max(
    nonNegativeIntegerValue(raw?.['nextSequence']) ?? 0,
    ...events.map((event) => event.sequence),
  );
  return { schemaVersion: 1, nextSequence, events };
}

function isWorkerControlEvent(
  value: unknown,
): value is AgentViewWorkerControlsFile['events'][number] {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value['sequence']) ||
    Number(value['sequence']) < 1 ||
    typeof value['at'] !== 'string'
  ) {
    return false;
  }
  if (value['type'] === 'redraw' || value['type'] === 'stop') return true;
  if (value['type'] === 'prompt') {
    return (
      typeof value['promptId'] === 'string' && typeof value['text'] === 'string'
    );
  }
  return (
    value['type'] === 'answer' &&
    typeof value['promptId'] === 'string' &&
    typeof value['callId'] === 'string' &&
    (value['text'] === undefined || typeof value['text'] === 'string') &&
    (value['outcome'] === undefined ||
      isWorkerAnswerOutcome(value['outcome'])) &&
    (value['payload'] === undefined || isRecord(value['payload']))
  );
}

function isWorkerAnswerOutcome(value: unknown): boolean {
  return (
    value === 'proceed_once' ||
    value === 'proceed_always' ||
    value === 'proceed_always_project' ||
    value === 'proceed_always_user' ||
    value === 'modify_with_editor' ||
    value === 'restore_previous' ||
    value === 'cancel'
  );
}

function normalizeCoordinationResult(
  raw: JsonRecord | undefined,
): AgentViewCoordinationResult | undefined {
  if (!raw || raw['schemaVersion'] !== 1 || !isRecord(raw['lineage'])) {
    return undefined;
  }
  const coordinationId = stringValue(raw['lineage']['coordinationId']);
  const taskId = stringValue(raw['lineage']['taskId']);
  const attemptId = stringValue(raw['lineage']['attemptId']);
  const sessionId = stringValue(raw['sessionId']);
  const promptId = stringValue(raw['promptId']);
  const generation = nonNegativeIntegerValue(raw['generation']);
  const outcome = raw['outcome'];
  const summary = stringValue(raw['summary']);
  const completedAt = stringValue(raw['completedAt']);
  if (
    !coordinationId ||
    !taskId ||
    !attemptId ||
    !sessionId ||
    !promptId ||
    generation === undefined ||
    generation < 1 ||
    (outcome !== 'completed' &&
      outcome !== 'failed' &&
      outcome !== 'handback') ||
    !summary ||
    !completedAt
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    lineage: { coordinationId, taskId, attemptId },
    sessionId,
    promptId,
    generation,
    outcome,
    summary,
    artifacts: stringArrayValue(raw['artifacts']),
    completedAt,
  };
}

function normalizeSupervisor(
  raw: JsonRecord | undefined,
): AgentViewSupervisorFile | undefined {
  if (!raw) return undefined;
  const pid = numberValue(raw['pid']);
  const socketPath = stringValue(raw['socketPath']);
  const authToken = stringValue(raw['authToken']);
  const startedAt = stringValue(raw['startedAt']);
  const updatedAt = stringValue(raw['updatedAt']);
  if (!pid || !socketPath || !startedAt || !updatedAt) return undefined;
  return {
    ...raw,
    schemaVersion: 1,
    pid,
    socketPath,
    ...(authToken ? { authToken } : {}),
    startedAt,
    updatedAt,
    protocolVersion: numberValue(raw['protocolVersion']) ?? 1,
  };
}

function ownershipValue(
  value: unknown,
): AgentViewSessionStateFile['ownership'] {
  return value === 'unmanaged' ||
    value === 'adopting' ||
    value === 'managed' ||
    value === 'removing'
    ? value
    : 'managed';
}

function sessionStateValue(
  value: unknown,
): AgentViewSessionStateFile['sessionState'] {
  return value === 'starting' ||
    value === 'working' ||
    value === 'needs_input' ||
    value === 'idle' ||
    value === 'completed' ||
    value === 'stopped' ||
    value === 'failed'
    ? value
    : 'failed';
}

function processStateValue(
  value: unknown,
): AgentViewSessionStateFile['processState'] {
  return value === 'starting' ||
    value === 'alive' ||
    value === 'hibernating' ||
    value === 'hibernated' ||
    value === 'restarting' ||
    value === 'exited'
    ? value
    : 'exited';
}

function attachStateValue(
  value: unknown,
): AgentViewSessionStateFile['attachState'] {
  return value === 'attaching' || value === 'attached' ? value : 'detached';
}

function worktreeModeValue(
  value: unknown,
): AgentViewSessionStateFile['worktree']['mode'] {
  return value === 'worktree' || value === 'shared-unisolated' ? value : 'none';
}

function inputKindValue(value: unknown): AgentViewActivityFile['inputKind'] {
  return value === 'blocking' || value === 'soft' ? value : undefined;
}

function terminalValue(value: unknown): AgentViewLaunchFile['terminal'] {
  if (!isRecord(value)) return { columns: 80, rows: 24 };
  return {
    columns: numberValue(value['columns']) ?? 80,
    rows: numberValue(value['rows']) ?? 24,
  };
}

function platformValue(value: unknown): NodeJS.Platform {
  return typeof value === 'string'
    ? (value as NodeJS.Platform)
    : process.platform;
}

function stringMapValue(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
