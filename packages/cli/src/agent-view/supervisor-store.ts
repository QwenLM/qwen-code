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
  AgentViewLaunchFile,
  AgentViewRosterEntry,
  AgentViewRosterFile,
  AgentViewSessionStateFile,
  AgentViewSessionSnapshot,
  AgentViewSupervisorFile,
  AgentViewWorkerFile,
} from './protocol.js';

type JsonRecord = Record<string, unknown>;

export interface AgentViewStorePaths {
  globalDir: string;
  daemonDir: string;
  rosterPath: string;
  supervisorPath: string;
  daemonLogPath: string;
  jobsDir: string;
}

export interface AgentViewSessionPaths {
  sessionDir: string;
  statePath: string;
  launchPath: string;
  activityPath: string;
  workerPath: string;
  tmpDir: string;
}

interface StoreOptions {
  globalDir?: string;
}

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
    tmpDir: path.join(sessionDir, 'tmp'),
  };
}

export async function readAgentViewRoster(
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  const raw = await readJsonRecord(getAgentViewStorePaths(options).rosterPath);
  return normalizeRoster(raw);
}

async function readAgentViewRosterForWrite(
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  const raw = await readJsonRecordForWrite(
    getAgentViewStorePaths(options).rosterPath,
  );
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
  const roster = await readAgentViewRosterForWrite(options);
  const key = sanitizeSessionId(entry.sessionId);
  const sessions = roster.sessions.filter(
    (item) => sanitizeSessionId(item.sessionId) !== key,
  );
  const existing = roster.sessions.find(
    (item) => sanitizeSessionId(item.sessionId) === key,
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
}

export async function removeAgentViewRosterEntry(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewRosterFile> {
  const roster = await readAgentViewRosterForWrite(options);
  const key = sanitizeSessionId(sessionId);
  const now = new Date().toISOString();
  const next: AgentViewRosterFile = {
    ...roster,
    schemaVersion: 1,
    updatedAt: now,
    sessions: roster.sessions.filter(
      (item) => sanitizeSessionId(item.sessionId) !== key,
    ),
  };
  await writeAgentViewRoster(next, options);
  return next;
}

export async function updateAgentViewRosterEntry(
  sessionId: string,
  update: (entry: AgentViewRosterEntry) => AgentViewRosterEntry,
  options: StoreOptions = {},
): Promise<AgentViewRosterEntry | undefined> {
  const roster = await readAgentViewRosterForWrite(options);
  const key = sanitizeSessionId(sessionId);
  let updated: AgentViewRosterEntry | undefined;
  const sessions = roster.sessions.map((entry) => {
    if (sanitizeSessionId(entry.sessionId) !== key) return entry;
    updated = update(entry);
    return updated;
  });
  if (!updated) return undefined;

  const next: AgentViewRosterFile = {
    ...roster,
    schemaVersion: 1,
    updatedAt: updated.updatedAt,
    sessions: sessions.sort(compareRosterEntries),
  };
  await writeAgentViewRoster(next, options);
  return updated;
}

export async function readAgentViewSessionState(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewSessionStateFile | undefined> {
  const paths = getAgentViewSessionPaths(sessionId, options);
  const raw = await readJsonRecord(paths.statePath);
  return normalizeSessionState(raw, path.basename(paths.sessionDir));
}

export async function writeAgentViewSessionState(
  state: AgentViewSessionStateFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(state.sessionId, options);
  const existing = await readJsonRecordForWrite(paths.statePath);
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
    roster.sessions.map((entry) => [sanitizeSessionId(entry.sessionId), entry]),
  );
  const snapshots = await Promise.all(
    states.map(async (state) => ({
      sessionId: state.sessionId,
      state,
      activity: await readAgentViewActivity(state.sessionId, options),
      worker: await readAgentViewWorker(state.sessionId, options),
      rosterEntry: rosterEntries.get(state.sessionId),
    })),
  );
  return snapshots.sort((left, right) =>
    right.state.updatedAt.localeCompare(left.state.updatedAt),
  );
}

export async function readAgentViewLaunch(
  sessionId: string,
  options: StoreOptions = {},
): Promise<AgentViewLaunchFile | undefined> {
  const paths = getAgentViewSessionPaths(sessionId, options);
  const raw = await readJsonRecord(paths.launchPath);
  return normalizeLaunch(raw, path.basename(paths.sessionDir));
}

export async function writeAgentViewLaunch(
  launch: AgentViewLaunchFile,
  options: StoreOptions = {},
): Promise<void> {
  const paths = getAgentViewSessionPaths(launch.sessionId, options);
  const existing = await readJsonRecordForWrite(paths.launchPath);
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
  const existing = await readJsonRecordForWrite(paths.activityPath);
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
  const existing = await readJsonRecordForWrite(paths.workerPath);
  await writeJsonFile(paths.workerPath, {
    ...existing,
    ...worker,
    schemaVersion: 1,
  });
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
  const existing = await readJsonRecordForWrite(paths.supervisorPath);
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

async function readJsonRecord(
  filePath: string,
): Promise<JsonRecord | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Fail soft on any read or parse error: one corrupt or odd entry under
    // jobs/ must not poison a full listing, which the supervisor would
    // misread as "unreachable" and then answer with a duplicate spawn.
    return undefined;
  }
}

async function readJsonRecordForWrite(
  filePath: string,
): Promise<JsonRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    // A missing file means there is nothing to merge. Any other read failure
    // (EMFILE, EIO) must surface: treating it as empty would silently drop
    // fields a previous or newer writer populated.
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Corrupt contents have no fields worth preserving; overwriting recovers.
    return undefined;
  }
}

async function writeJsonFile(
  filePath: string,
  value: JsonRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // noFollow: these files carry the supervisor and worker auth tokens;
  // refuse to write through a pre-placed symlink at the store path, matching
  // the other credential write sites (trustedHooks, file-token-storage).
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
    displayName: stringValue(value['displayName']),
    pinned: typeof value['pinned'] === 'boolean' ? value['pinned'] : undefined,
    createdAt,
    updatedAt,
  };
}

function normalizeSessionState(
  raw: JsonRecord | undefined,
  expectedSessionId: string,
): AgentViewSessionStateFile | undefined {
  if (!raw) return undefined;
  // The directory name (already sanitized) is the source of truth; trusting
  // the file's sessionId would let one directory impersonate another and mix
  // per-session files across directories.
  const sessionId = expectedSessionId || stringValue(raw['sessionId']);
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
  // Mirror normalizeSessionState: the sanitized directory name is the source
  // of truth, so a tampered launch.json cannot impersonate another session.
  const sessionId = expectedSessionId || stringValue(raw['sessionId']);
  const entrypoint = stringValue(raw['entrypoint']);
  const projectCwd = stringValue(raw['projectCwd']);
  const activeCwd = stringValue(raw['activeCwd']);
  if (!sessionId || !entrypoint || !projectCwd || !activeCwd) return undefined;
  return {
    ...raw,
    schemaVersion: 1,
    sessionId,
    argv: stringArrayValue(raw['argv']),
    env: stringMapValue(raw['env']),
    entrypoint,
    projectCwd: path.resolve(projectCwd),
    activeCwd: path.resolve(activeCwd),
    includeDirectories: stringArrayValue(raw['includeDirectories']),
    terminal: terminalValue(raw['terminal']),
  };
}

function normalizeActivity(
  raw: JsonRecord | undefined,
): AgentViewActivityFile | undefined {
  if (!raw) return undefined;
  const lastActivityAt = stringValue(raw['lastActivityAt']);
  if (!lastActivityAt) return undefined;
  return {
    ...raw,
    schemaVersion: 1,
    summary: stringValue(raw['summary']),
    waitingFor: stringValue(raw['waitingFor']),
    lastResult: stringValue(raw['lastResult']),
    lastActivityAt,
    capabilities: stringArrayValue(raw['capabilities']),
  };
}

function normalizeWorker(
  raw: JsonRecord | undefined,
): AgentViewWorkerFile | undefined {
  if (!raw) return undefined;
  return {
    ...raw,
    schemaVersion: 1,
    hostPid: numberValue(raw['hostPid']),
    workerPid: numberValue(raw['workerPid']),
    endpoint: stringValue(raw['endpoint']),
    hostEndpoint: stringValue(raw['hostEndpoint']),
    hostAuthToken: stringValue(raw['hostAuthToken']),
    tokenDigest: stringValue(raw['tokenDigest']),
    lastHeartbeatAt: stringValue(raw['lastHeartbeatAt']),
    protocolVersion: numberValue(raw['protocolVersion']) ?? 1,
    platform: platformValue(raw['platform']),
    recentOutputBytes: numberValue(raw['recentOutputBytes']) ?? 0,
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
    authToken,
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

function terminalValue(value: unknown): AgentViewLaunchFile['terminal'] {
  if (!isRecord(value)) return { columns: 80, rows: 24 };
  return {
    columns: numberValue(value['columns']) ?? 80,
    rows: numberValue(value['rows']) ?? 24,
  };
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set([
  'aix',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);

function platformValue(value: unknown): NodeJS.Platform {
  return typeof value === 'string' && KNOWN_PLATFORMS.has(value)
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
