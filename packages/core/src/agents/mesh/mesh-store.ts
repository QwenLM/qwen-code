/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import lockfile from 'proper-lockfile';

import { Storage } from '../../config/storage.js';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import { getProjectHash } from '../../utils/paths.js';
import {
  DEFAULT_QUEUE_LIMIT,
  HUMAN_AUTHOR_ID,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_RUNS,
  MESH_SCHEMA_VERSION,
  type MeshAgent,
  type MeshNotifyTarget,
  type MeshAgentsFile,
  type MeshWorkspaceState,
  type MessageOutcome,
  type RunCloseKind,
  type RunUsageRound,
  type Thread,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadRun,
  type ThreadRunStatus,
  type ThreadStatus,
} from './types.js';

const MESH_DIRNAME = 'mesh';
const WORKSPACE_FILENAME = 'workspace.json';
const AGENTS_FILENAME = 'agents.json';
const THREADS_DIRNAME = 'threads';

export const MESH_DISPLAY_PATH = `~/.qwen/tmp/<project-hash>/${MESH_DIRNAME}`;

const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    randomize: true,
  },
  stale: 10_000,
};

const workspaceMutexes = new Map<string, Mutex>();
const workspaceTransaction = new AsyncLocalStorage<boolean>();

export class MeshSchemaVersionError extends Error {
  constructor(
    readonly filePath: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Unsupported mesh schema version ${JSON.stringify(foundVersion)} in ${filePath}; this build supports version ${MESH_SCHEMA_VERSION}.`,
    );
    this.name = 'MeshSchemaVersionError';
  }
}

export function getMeshDir(projectRoot: string): string {
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    MESH_DIRNAME,
  );
}

export function getWorkspaceFilePath(projectRoot: string): string {
  return path.join(getMeshDir(projectRoot), WORKSPACE_FILENAME);
}

export function getAgentsFilePath(projectRoot: string): string {
  return path.join(getMeshDir(projectRoot), AGENTS_FILENAME);
}

export function getThreadsDir(projectRoot: string): string {
  return path.join(getMeshDir(projectRoot), THREADS_DIRNAME);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function generateAgentId(): string {
  return `ag_${randomUUID()}`;
}

export function generateThreadId(): string {
  return `th_${randomUUID()}`;
}

export function generateMessageId(): string {
  return `ms_${randomUUID()}`;
}

export function generateRunId(): string {
  return `rn_${randomUUID()}`;
}

export function generateEventId(): string {
  return `ev_${randomUUID()}`;
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function getThreadPath(projectRoot: string, threadId: string): string {
  if (!isValidId(threadId)) {
    throw new Error(`Invalid thread id: ${JSON.stringify(threadId)}`);
  }
  return path.join(getThreadsDir(projectRoot), `${threadId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}

/**
 * Absent is valid: an agent that has never been started has no body yet. A
 * half-written binding is not — it would name a session that may not exist,
 * and the dispatcher would treat a stale handle as a live one.
 */
function isValidAgentRuntime(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value['mode'] !== 'local') return false;
  return (
    value['sessionId'] === undefined || isNonEmptyString(value['sessionId'])
  );
}

function isValidAgent(value: unknown): value is MeshAgent {
  if (!isRecord(value)) return false;
  return (
    isValidId(value['id']) &&
    isValidAgentName(value['name']) &&
    isFiniteTimestamp(value['createdAt']) &&
    (value['description'] === undefined ||
      typeof value['description'] === 'string') &&
    (value['color'] === undefined ||
      (typeof value['color'] === 'string' && HEX_COLOR.test(value['color']))) &&
    (value['agentType'] === undefined ||
      isNonEmptyString(value['agentType'])) &&
    (value['model'] === undefined || isNonEmptyString(value['model'])) &&
    (value['queueLimit'] === undefined ||
      isPositiveInteger(value['queueLimit'])) &&
    (value['enabled'] === undefined || typeof value['enabled'] === 'boolean') &&
    (value['backgroundAgentId'] === undefined ||
      isNonEmptyString(value['backgroundAgentId'])) &&
    (value['retiredAt'] === undefined ||
      isFiniteTimestamp(value['retiredAt'])) &&
    (value['maxConcurrentRuns'] === undefined ||
      isPositiveInteger(value['maxConcurrentRuns'])) &&
    isValidAgentRuntime(value['runtime']) &&
    (value['runtimeId'] === undefined || isNonEmptyString(value['runtimeId']))
  );
}

const RUN_STATUSES = new Set<ThreadRunStatus>([
  'queued',
  'running',
  'finishing',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
]);

const THREAD_STATUSES = new Set<ThreadStatus>([
  'open',
  'in_progress',
  'blocked',
  'in_review',
  'done',
]);

const CLOSE_KINDS = new Set<RunCloseKind>([
  'waiting',
  'blocked',
  'review',
  'unclosed',
]);

function isValidOutcome(value: unknown): value is MessageOutcome {
  if (!isRecord(value)) return false;
  const commonFieldsAreValid =
    (value['targetAgentId'] === undefined ||
      isValidId(value['targetAgentId'])) &&
    (value['targetAgentName'] === undefined ||
      typeof value['targetAgentName'] === 'string') &&
    (value['reason'] === undefined || typeof value['reason'] === 'string') &&
    (value['runId'] === undefined || isValidId(value['runId'])) &&
    (value['into'] === undefined ||
      value['into'] === 'queued' ||
      value['into'] === 'running');
  if (!commonFieldsAreValid) return false;
  if (value['kind'] === 'dispatch') {
    return (
      isValidId(value['targetAgentId']) &&
      isValidId(value['runId']) &&
      value['reason'] === undefined &&
      value['into'] === undefined
    );
  }
  if (value['kind'] === 'coalesce') {
    return (
      isValidId(value['targetAgentId']) &&
      isValidId(value['runId']) &&
      (value['into'] === 'queued' || value['into'] === 'running') &&
      value['reason'] === undefined
    );
  }
  return (
    value['kind'] === 'skip' &&
    isNonEmptyString(value['reason']) &&
    value['runId'] === undefined &&
    value['into'] === undefined
  );
}

function isValidMessage(value: unknown): value is ThreadMessage {
  if (!isRecord(value)) return false;
  return (
    isValidId(value['id']) &&
    isPositiveInteger(value['sequence']) &&
    (value['authorKind'] === 'human' ||
      value['authorKind'] === 'agent' ||
      value['authorKind'] === 'system') &&
    isNonEmptyString(value['from']) &&
    isNonEmptyString(value['authorNameSnapshot']) &&
    (value['sourceRunId'] === undefined || isValidId(value['sourceRunId'])) &&
    (value['triggerKind'] === undefined ||
      isNonEmptyString(value['triggerKind'])) &&
    typeof value['text'] === 'string' &&
    Array.isArray(value['mentions']) &&
    value['mentions'].every(isValidId) &&
    Array.isArray(value['outcomes']) &&
    value['outcomes'].every(isValidOutcome) &&
    isFiniteTimestamp(value['at']) &&
    (value['originEventId'] === undefined || isValidId(value['originEventId']))
  );
}

function isValidUsageRound(value: unknown): value is RunUsageRound {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value['attempt']) &&
    isNonNegativeInteger(value['round']) &&
    isNonNegativeInteger(value['tokens'])
  );
}

function isValidRun(value: unknown): value is ThreadRun {
  if (!isRecord(value)) return false;
  const valid =
    isValidId(value['id']) &&
    isValidId(value['agentId']) &&
    RUN_STATUSES.has(value['status'] as ThreadRunStatus) &&
    Array.isArray(value['triggerMessageIds']) &&
    value['triggerMessageIds'].every(isValidId) &&
    Array.isArray(value['acceptedMessageIds']) &&
    value['acceptedMessageIds'].every(isValidId) &&
    Array.isArray(value['consumedMessageIds']) &&
    value['consumedMessageIds'].every(isValidId) &&
    isOptionalNonNegativeInteger(value['contextThroughSequence']) &&
    (value['definitionVersion'] === undefined ||
      isNonEmptyString(value['definitionVersion'])) &&
    isOptionalNonNegativeInteger(value['transcriptStartOffset']) &&
    isOptionalNonNegativeInteger(value['transcriptEndOffset']) &&
    (value['closeKind'] === undefined ||
      CLOSE_KINDS.has(value['closeKind'] as RunCloseKind)) &&
    isOptionalNonNegativeInteger(value['closeAcknowledgedAtSequence']) &&
    (value['finalMessageId'] === undefined ||
      isValidId(value['finalMessageId'])) &&
    Array.isArray(value['usageByRound']) &&
    value['usageByRound'].every(isValidUsageRound) &&
    (value['failureStage'] === undefined ||
      isNonEmptyString(value['failureStage'])) &&
    isPositiveInteger(value['queueSequence']) &&
    isNonNegativeInteger(value['attempts']) &&
    isFiniteTimestamp(value['queuedAt']) &&
    (value['sessionId'] === undefined ||
      isNonEmptyString(value['sessionId'])) &&
    (value['startedAt'] === undefined ||
      isFiniteTimestamp(value['startedAt'])) &&
    (value['endedAt'] === undefined || isFiniteTimestamp(value['endedAt'])) &&
    (value['error'] === undefined || typeof value['error'] === 'string');
  if (!valid) return false;
  const keys = new Set<string>();
  for (const usage of value['usageByRound'] as RunUsageRound[]) {
    const key = `${usage.attempt}:${usage.round}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isValidEvent(value: unknown): value is ThreadEvent {
  if (!isRecord(value)) return false;
  return (
    isValidId(value['id']) &&
    (value['kind'] === 'parent_report' || value['kind'] === 'notification') &&
    (value['causedByRunId'] === undefined ||
      isValidId(value['causedByRunId'])) &&
    isRecord(value['payload']) &&
    (value['status'] === 'pending' || value['status'] === 'acknowledged') &&
    isNonNegativeInteger(value['attempts']) &&
    isFiniteTimestamp(value['createdAt'])
  );
}

function isValidThread(value: unknown): value is Thread {
  if (!isRecord(value)) return false;
  if (
    value['schemaVersion'] !== MESH_SCHEMA_VERSION ||
    !isValidId(value['id']) ||
    typeof value['title'] !== 'string' ||
    typeof value['body'] !== 'string' ||
    !THREAD_STATUSES.has(value['status'] as ThreadStatus) ||
    !isFiniteTimestamp(value['createdAt']) ||
    !isNonEmptyString(value['createdBy']) ||
    !Array.isArray(value['messages']) ||
    !value['messages'].every(isValidMessage) ||
    !Array.isArray(value['runs']) ||
    !value['runs'].every(isValidRun) ||
    !isPositiveInteger(value['nextMessageSequence']) ||
    !isRecord(value['deliveryByAgent']) ||
    !Object.entries(value['deliveryByAgent']).every(
      ([agentId, delivery]) =>
        isValidId(agentId) &&
        isRecord(delivery) &&
        isNonNegativeInteger(delivery['committedThroughSequence']),
    ) ||
    !Array.isArray(value['outbox']) ||
    !value['outbox'].every(isValidEvent) ||
    !isNonNegativeInteger(value['autoTurnsUsed']) ||
    !isNonNegativeInteger(value['tokensUsed']) ||
    !isValidId(value['rootThreadId']) ||
    (value['parentThreadId'] !== undefined &&
      !isValidId(value['parentThreadId'])) ||
    (value['assigneeAgentId'] !== undefined &&
      !isValidId(value['assigneeAgentId']))
  ) {
    return false;
  }
  let previousSequence = 0;
  const messageIds = new Set<string>();
  const originEventIds = new Set<string>();
  for (const message of value['messages']) {
    if (message.sequence <= previousSequence) return false;
    previousSequence = message.sequence;
    if (messageIds.has(message.id)) return false;
    messageIds.add(message.id);
    if (message.originEventId) {
      if (originEventIds.has(message.originEventId)) return false;
      originEventIds.add(message.originEventId);
    }
  }
  const runIds = new Set<string>();
  const queueSequences = new Set<number>();
  for (const run of value['runs']) {
    if (runIds.has(run.id) || queueSequences.has(run.queueSequence))
      return false;
    runIds.add(run.id);
    queueSequences.add(run.queueSequence);
  }
  const eventIds = new Set<string>();
  for (const event of value['outbox']) {
    if (eventIds.has(event.id)) return false;
    eventIds.add(event.id);
  }
  return value['nextMessageSequence'] > previousSequence;
}

/**
 * Absent is valid: no destination has been chosen yet. A malformed one is not
 * — a half-written target would send somebody's work to the wrong place, and
 * the store's rule is that a file which exists but does not parse is
 * corruption rather than emptiness.
 */
function isValidNotifyTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const target = value['target'];
  return (
    isNonEmptyString(value['channelName']) &&
    isRecord(target) &&
    (target['type'] === 'user' || target['type'] === 'chat') &&
    isNonEmptyString(target['id'])
  );
}

function isValidWorkspace(value: unknown): value is MeshWorkspaceState {
  return (
    isRecord(value) &&
    value['schemaVersion'] === MESH_SCHEMA_VERSION &&
    isValidId(value['workspaceId']) &&
    (value['hostSessionId'] === undefined ||
      isNonEmptyString(value['hostSessionId'])) &&
    isPositiveInteger(value['nextRunSequence']) &&
    isValidNotifyTarget(value['notifyTarget'])
  );
}

function assertKnownVersion(value: unknown, filePath: string): void {
  if (!isRecord(value) || value['schemaVersion'] === undefined) {
    throw new MeshSchemaVersionError(filePath, undefined);
  }
  if (value['schemaVersion'] !== MESH_SCHEMA_VERSION) {
    throw new MeshSchemaVersionError(filePath, value['schemaVersion']);
  }
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as empty.`,
    );
  }
}

function workspaceMutex(meshDir: string): Mutex {
  let mutex = workspaceMutexes.get(meshDir);
  if (!mutex) {
    mutex = new Mutex();
    workspaceMutexes.set(meshDir, mutex);
  }
  return mutex;
}

async function withWorkspaceLock<T>(
  projectRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  if (workspaceTransaction.getStore()) {
    throw new Error('Nested mesh workspace transactions are not allowed.');
  }
  const meshDir = getMeshDir(projectRoot);
  return workspaceMutex(meshDir).runExclusive(async () => {
    await fs.mkdir(meshDir, { recursive: true });
    const release = await lockfile.lock(
      getWorkspaceFilePath(projectRoot),
      LOCK_OPTIONS,
    );
    try {
      return await workspaceTransaction.run(true, run);
    } finally {
      await release();
    }
  });
}

function backupPath(filePath: string): string {
  return filePath.replace(/\.json$/, '.v0.json');
}

async function writeBackup(filePath: string, value: unknown): Promise<void> {
  const target = backupPath(filePath);
  try {
    await fs.access(target);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    await atomicWriteJSON(target, value, { noFollow: true });
  }
}

async function replaceMigratedFile<T>(
  filePath: string,
  legacy: unknown,
  migrated: T,
  validate: (value: unknown) => value is T,
): Promise<void> {
  await writeBackup(filePath, legacy);
  await atomicWriteJSON(filePath, migrated, { noFollow: true });
  const reread = await readJsonFile(filePath);
  if (!validate(reread)) {
    throw new Error(`Migrated mesh record failed validation: ${filePath}.`);
  }
  await fs.unlink(backupPath(filePath));
}

function migrateAgent(value: unknown): MeshAgent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value['hostSessionId'] !== undefined &&
    !isNonEmptyString(value['hostSessionId'])
  ) {
    return undefined;
  }
  const agent = { ...value };
  delete agent['hostSessionId'];
  return isValidAgent(agent) ? agent : undefined;
}

function legacyHostSessionId(agents: readonly unknown[]): string | undefined {
  const ids = new Set(
    agents
      .filter(isRecord)
      .map((agent) => agent['hostSessionId'])
      .filter(isNonEmptyString),
  );
  if (ids.size > 1) {
    throw new Error(
      'Cannot migrate agents with conflicting hostSessionId values.',
    );
  }
  return ids.values().next().value;
}

function migrateMessage(
  value: unknown,
  sequence: number,
  agents: readonly MeshAgent[],
): ThreadMessage {
  if (!isRecord(value)) throw new Error('Malformed v0 thread message.');
  const from = value['from'];
  const author = agents.find((agent) => agent.id === from);
  const message: ThreadMessage = {
    id: value['id'] as string,
    sequence,
    authorKind: from === HUMAN_AUTHOR_ID ? 'human' : 'agent',
    from: from as string,
    authorNameSnapshot:
      from === HUMAN_AUTHOR_ID
        ? HUMAN_AUTHOR_ID
        : (author?.name ?? String(from)),
    text: value['text'] as string,
    mentions: value['mentions'] as string[],
    outcomes: [],
    at: value['at'] as number,
  };
  if (!isValidMessage(message)) throw new Error('Malformed v0 thread message.');
  return message;
}

function migrateRun(value: unknown, queueSequence: number): ThreadRun {
  if (!isRecord(value)) throw new Error('Malformed v0 thread run.');
  const run: ThreadRun = {
    id: value['id'] as string,
    agentId: value['agentId'] as string,
    status: value['status'] as ThreadRunStatus,
    triggerMessageIds: value['triggerMessageIds'] as string[],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence,
    attempts: value['attempts'] as number,
    queuedAt: value['queuedAt'] as number,
    ...(value['sessionId'] !== undefined
      ? { sessionId: value['sessionId'] as string }
      : {}),
    ...(value['startedAt'] !== undefined
      ? { startedAt: value['startedAt'] as number }
      : {}),
    ...(value['endedAt'] !== undefined
      ? { endedAt: value['endedAt'] as number }
      : {}),
    ...(value['error'] !== undefined
      ? { error: value['error'] as string }
      : {}),
  };
  if (!isValidRun(run)) throw new Error('Malformed v0 thread run.');
  return run;
}

function sumRunTokens(runs: readonly ThreadRun[]): number {
  return runs.reduce(
    (total, run) =>
      total + run.usageByRound.reduce((sum, usage) => sum + usage.tokens, 0),
    0,
  );
}

function migrateThread(
  value: unknown,
  agents: readonly MeshAgent[],
  allocateRunSequence: () => number,
): Thread {
  if (!isRecord(value)) throw new Error('Malformed v0 thread record.');
  if (
    !Array.isArray(value['messages']) ||
    !Array.isArray(value['runs']) ||
    !isNonNegativeInteger(value['tokensUsed'])
  ) {
    throw new Error('Malformed v0 thread record.');
  }
  const messages = value['messages'].map((message, index) =>
    migrateMessage(message, index + 1, agents),
  );
  const runs = value['runs'].map((run) =>
    migrateRun(run, allocateRunSequence()),
  );
  const oldTokens = value['tokensUsed'];
  if (isPositiveInteger(oldTokens)) {
    const lastRun = runs.at(-1);
    if (!lastRun) {
      throw new Error('Cannot migrate non-zero tokensUsed without a run.');
    }
    lastRun.usageByRound.push({
      attempt: Math.max(1, lastRun.attempts),
      round: 0,
      tokens: oldTokens,
    });
  }
  const thread: Thread = {
    schemaVersion: MESH_SCHEMA_VERSION,
    id: value['id'] as string,
    title: value['title'] as string,
    body: value['body'] as string,
    status: value['status'] as ThreadStatus,
    createdAt: value['createdAt'] as number,
    createdBy: value['createdBy'] as string,
    rootThreadId: value['rootThreadId'] as string,
    messages,
    runs,
    nextMessageSequence: messages.length + 1,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed: value['autoTurnsUsed'] as number,
    tokensUsed: sumRunTokens(runs),
    ...(value['parentThreadId'] !== undefined
      ? { parentThreadId: value['parentThreadId'] as string }
      : {}),
    ...(value['assigneeAgentId'] !== undefined
      ? { assigneeAgentId: value['assigneeAgentId'] as string }
      : {}),
  };
  if (!isValidThread(thread)) throw new Error('Malformed v0 thread record.');
  return thread;
}

async function listThreadIdsUnlocked(projectRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getThreadsDir(projectRoot));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((name) => name.endsWith('.json') && !name.endsWith('.v0.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidId)
    .sort();
}

function agentsFileIsValid(value: unknown): value is MeshAgentsFile {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== MESH_SCHEMA_VERSION ||
    !Array.isArray(value['agents']) ||
    !value['agents'].every(isValidAgent)
  ) {
    return false;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const agent of value['agents']) {
    const name = agent.name.toLowerCase();
    if (ids.has(agent.id) || names.has(name)) return false;
    ids.add(agent.id);
    names.add(name);
  }
  return true;
}

async function ensureMigratedUnlocked(
  projectRoot: string,
): Promise<MeshWorkspaceState> {
  const workspacePath = getWorkspaceFilePath(projectRoot);
  const currentWorkspace = await readJsonFile(workspacePath);
  if (currentWorkspace !== undefined && isValidWorkspace(currentWorkspace)) {
    try {
      await fs.unlink(backupPath(workspacePath));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    return currentWorkspace;
  }
  if (currentWorkspace !== undefined) {
    assertKnownVersion(currentWorkspace, workspacePath);
    throw new Error(`Malformed mesh workspace record in ${workspacePath}.`);
  }

  const agentsPath = getAgentsFilePath(projectRoot);
  const currentAgents = await readJsonFile(agentsPath);
  if (
    isRecord(currentAgents) &&
    typeof currentAgents['schemaVersion'] === 'number' &&
    currentAgents['schemaVersion'] > MESH_SCHEMA_VERSION
  ) {
    throw new MeshSchemaVersionError(
      agentsPath,
      currentAgents['schemaVersion'],
    );
  }
  const agentsBackup = await readJsonFile(backupPath(agentsPath));
  const rawAgents = agentsFileIsValid(currentAgents)
    ? currentAgents
    : (agentsBackup ?? currentAgents);
  let agents: MeshAgent[];
  let hostSessionId: string | undefined;
  if (rawAgents === undefined) {
    agents = [];
    await atomicWriteJSON(
      agentsPath,
      { schemaVersion: MESH_SCHEMA_VERSION, agents } satisfies MeshAgentsFile,
      { noFollow: true },
    );
  } else if (agentsFileIsValid(rawAgents)) {
    agents = rawAgents.agents;
    try {
      await fs.unlink(backupPath(agentsPath));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  } else if (Array.isArray(rawAgents)) {
    hostSessionId = legacyHostSessionId(rawAgents);
    agents = [];
    for (const rawAgent of rawAgents) {
      const agent = migrateAgent(rawAgent);
      if (!agent)
        throw new Error('Cannot migrate a malformed v0 agent record.');
      agents.push(agent);
    }
    const migratedAgents = {
      schemaVersion: MESH_SCHEMA_VERSION,
      agents,
    } satisfies MeshAgentsFile;
    if (!agentsFileIsValid(migratedAgents)) {
      throw new Error('Cannot migrate malformed or duplicate v0 agents.');
    }
    await replaceMigratedFile(
      agentsPath,
      rawAgents,
      migratedAgents,
      agentsFileIsValid,
    );
  } else {
    assertKnownVersion(rawAgents, agentsPath);
    throw new Error(`Malformed mesh agents record in ${agentsPath}.`);
  }

  const threadIds = await listThreadIdsUnlocked(projectRoot);
  const rawThreads = new Map<string, unknown>();
  let nextRunSequence = 1;
  for (const threadId of threadIds) {
    const filePath = getThreadPath(projectRoot, threadId);
    const current = await readJsonFile(filePath);
    if (
      isRecord(current) &&
      typeof current['schemaVersion'] === 'number' &&
      current['schemaVersion'] > MESH_SCHEMA_VERSION
    ) {
      throw new MeshSchemaVersionError(filePath, current['schemaVersion']);
    }
    const savedLegacy = await readJsonFile(backupPath(filePath));
    const raw = isValidThread(current) ? current : (savedLegacy ?? current);
    rawThreads.set(threadId, raw);
    if (isValidThread(raw)) {
      for (const run of raw.runs) {
        nextRunSequence = Math.max(nextRunSequence, run.queueSequence + 1);
      }
    }
  }
  for (const threadId of threadIds) {
    const filePath = getThreadPath(projectRoot, threadId);
    const raw = rawThreads.get(threadId);
    if (isValidThread(raw)) {
      try {
        await fs.unlink(backupPath(filePath));
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
      continue;
    }
    if (isRecord(raw) && raw['schemaVersion'] !== undefined) {
      assertKnownVersion(raw, filePath);
      throw new Error(`Malformed thread record in ${filePath}.`);
    }
    const migrated = migrateThread(raw, agents, () => nextRunSequence++);
    if (migrated.id !== threadId) {
      throw new Error(
        `Thread id mismatch: file ${threadId}.json contains id ${migrated.id}.`,
      );
    }
    await replaceMigratedFile(filePath, raw, migrated, isValidThread);
  }

  const workspace: MeshWorkspaceState = {
    schemaVersion: MESH_SCHEMA_VERSION,
    workspaceId: `ws_${randomUUID()}`,
    nextRunSequence,
    ...(hostSessionId ? { hostSessionId } : {}),
  };
  await atomicWriteJSON(workspacePath, workspace, { noFollow: true });
  const reread = await readJsonFile(workspacePath);
  if (!isValidWorkspace(reread)) {
    throw new Error(
      `Migrated mesh record failed validation: ${workspacePath}.`,
    );
  }
  return workspace;
}

export async function ensureMigrated(projectRoot: string): Promise<void> {
  const current = await readJsonFile(getWorkspaceFilePath(projectRoot));
  if (isValidWorkspace(current)) return;
  await withWorkspaceLock(projectRoot, async () => {
    await ensureMigratedUnlocked(projectRoot);
  });
}

async function readAgentsUnlocked(projectRoot: string): Promise<MeshAgent[]> {
  const filePath = getAgentsFilePath(projectRoot);
  const parsed = await readJsonFile(filePath);
  if (parsed === undefined) return [];
  assertKnownVersion(parsed, filePath);
  if (!agentsFileIsValid(parsed)) {
    throw new Error(`Malformed mesh agents record in ${filePath}.`);
  }
  return parsed.agents;
}

async function writeAgentsUnlocked(
  projectRoot: string,
  agents: readonly MeshAgent[],
): Promise<void> {
  const record = {
    schemaVersion: MESH_SCHEMA_VERSION,
    agents: [...agents],
  } satisfies MeshAgentsFile;
  if (!agentsFileIsValid(record)) {
    throw new Error('Refusing to write malformed mesh agents.');
  }
  await atomicWriteJSON(getAgentsFilePath(projectRoot), record, {
    noFollow: true,
  });
}

async function readThreadUnlocked(
  projectRoot: string,
  threadId: string,
): Promise<Thread | undefined> {
  const filePath = getThreadPath(projectRoot, threadId);
  const parsed = await readJsonFile(filePath);
  if (parsed === undefined) return undefined;
  assertKnownVersion(parsed, filePath);
  if (!isValidThread(parsed)) {
    throw new Error(`Malformed thread record in ${filePath}.`);
  }
  if (parsed.id !== threadId) {
    throw new Error(
      `Thread id mismatch: file ${threadId}.json contains id ${parsed.id}.`,
    );
  }
  return parsed;
}

async function listThreadsUnlocked(
  projectRoot: string,
): Promise<{ threads: Thread[]; unreadable: string[] }> {
  const threads: Thread[] = [];
  const unreadable: string[] = [];
  for (const id of await listThreadIdsUnlocked(projectRoot)) {
    try {
      const thread = await readThreadUnlocked(projectRoot, id);
      if (thread) threads.push(thread);
    } catch (error) {
      if (error instanceof MeshSchemaVersionError) throw error;
      unreadable.push(id);
    }
  }
  threads.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return { threads, unreadable };
}

function trimThread(thread: Thread): Thread {
  if (
    thread.messages.length <= MAX_THREAD_MESSAGES &&
    thread.runs.length <= MAX_THREAD_RUNS
  ) {
    return thread;
  }
  const firstRetainedMessage = Math.max(
    0,
    thread.messages.length - MAX_THREAD_MESSAGES,
  );
  const firstRetainedRun = Math.max(0, thread.runs.length - MAX_THREAD_RUNS);
  const retainedRuns = thread.runs.filter(
    (run, index) =>
      index >= firstRetainedRun ||
      run.usageByRound.length > 0 ||
      run.status === 'queued' ||
      run.status === 'running' ||
      run.status === 'finishing' ||
      run.status === 'cancelling',
  );
  const referencedMessageIds = new Set(
    retainedRuns.flatMap((run) => [
      ...run.triggerMessageIds,
      ...run.acceptedMessageIds,
      ...run.consumedMessageIds,
      ...(run.finalMessageId ? [run.finalMessageId] : []),
    ]),
  );
  return {
    ...thread,
    messages: thread.messages.filter(
      (message, index) =>
        index >= firstRetainedMessage ||
        message.originEventId !== undefined ||
        referencedMessageIds.has(message.id),
    ),
    runs: retainedRuns,
  };
}

async function writeThreadUnlocked(
  projectRoot: string,
  thread: Thread,
): Promise<Thread> {
  const next = trimThread({ ...thread, tokensUsed: sumRunTokens(thread.runs) });
  if (!isValidThread(next)) {
    throw new Error(
      `Refusing to write malformed thread record "${thread.id}".`,
    );
  }
  const filePath = getThreadPath(projectRoot, next.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, next, { noFollow: true });
  return next;
}

export interface MeshStoreTransaction {
  readonly projectRoot: string;
  readonly workspaceId: string;
  readAgents(): Promise<MeshAgent[]>;
  writeAgents(agents: readonly MeshAgent[]): Promise<void>;
  readThread(threadId: string): Promise<Thread | undefined>;
  listThreads(): Promise<{ threads: Thread[]; unreadable: string[] }>;
  writeThread(thread: Thread): Promise<Thread>;
  deleteThreadFile(threadId: string): Promise<boolean>;
  allocateRunSequence(): Promise<number>;
  threadTreeTokens(rootThreadId: string): Promise<number>;
}

function makeTransaction(
  projectRoot: string,
  initialWorkspace: MeshWorkspaceState,
): MeshStoreTransaction {
  let workspace = initialWorkspace;
  return {
    projectRoot,
    workspaceId: workspace.workspaceId,
    readAgents: () => readAgentsUnlocked(projectRoot),
    writeAgents: (agents) => writeAgentsUnlocked(projectRoot, agents),
    readThread: (threadId) => readThreadUnlocked(projectRoot, threadId),
    listThreads: () => listThreadsUnlocked(projectRoot),
    writeThread: (thread) => writeThreadUnlocked(projectRoot, thread),
    deleteThreadFile: async (threadId) => {
      try {
        await fs.unlink(getThreadPath(projectRoot, threadId));
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return false;
        throw error;
      }
    },
    allocateRunSequence: async () => {
      const sequence = workspace.nextRunSequence;
      workspace = { ...workspace, nextRunSequence: sequence + 1 };
      await atomicWriteJSON(getWorkspaceFilePath(projectRoot), workspace, {
        noFollow: true,
      });
      return sequence;
    },
    threadTreeTokens: async (rootThreadId) => {
      const { threads, unreadable } = await listThreadsUnlocked(projectRoot);
      if (unreadable.length > 0) {
        throw new Error(
          `Cannot calculate thread budget while records are unreadable: ${unreadable.join(', ')}.`,
        );
      }
      return threads
        .filter((thread) => thread.rootThreadId === rootThreadId)
        .reduce((sum, thread) => sum + sumRunTokens(thread.runs), 0);
    },
  };
}

export async function withMeshStoreTransaction<T>(
  projectRoot: string,
  run: (transaction: MeshStoreTransaction) => Promise<T>,
): Promise<T> {
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureMigratedUnlocked(projectRoot);
    return run(makeTransaction(projectRoot, workspace));
  });
}

export async function readMeshWorkspace(
  projectRoot: string,
): Promise<MeshWorkspaceState> {
  return withMeshStoreTransaction(projectRoot, async () => {
    const filePath = getWorkspaceFilePath(projectRoot);
    const parsed = await readJsonFile(filePath);
    if (!isValidWorkspace(parsed)) {
      assertKnownVersion(parsed, filePath);
      throw new Error('Malformed mesh workspace record.');
    }
    return parsed;
  });
}

/**
 * Sets, or clears, where this workspace's notifications go.
 *
 * Separate from every other workspace write because it is the one field a
 * person chooses rather than the system allocates. Passing `undefined` turns
 * notifications off again, and the events that were already queued stay
 * pending rather than being dropped on the way out.
 */
export async function setMeshNotifyTarget(
  projectRoot: string,
  target: MeshNotifyTarget | undefined,
): Promise<MeshWorkspaceState> {
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureMigratedUnlocked(projectRoot);
    const next: MeshWorkspaceState = target
      ? { ...workspace, notifyTarget: target }
      : (() => {
          const { notifyTarget: _dropped, ...rest } = workspace;
          return rest;
        })();
    await atomicWriteJSON(getWorkspaceFilePath(projectRoot), next, {
      noFollow: true,
    });
    return next;
  });
}

export async function claimMeshHostSession(
  projectRoot: string,
  candidateSessionId: string,
): Promise<string> {
  if (!isNonEmptyString(candidateSessionId)) {
    throw new Error('Mesh host session id must be a non-empty string.');
  }
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureMigratedUnlocked(projectRoot);
    if (workspace.hostSessionId) return workspace.hostSessionId;
    await atomicWriteJSON(
      getWorkspaceFilePath(projectRoot),
      { ...workspace, hostSessionId: candidateSessionId },
      { noFollow: true },
    );
    return candidateSessionId;
  });
}

export async function releaseMeshHostSession(
  projectRoot: string,
  expectedSessionId: string,
): Promise<boolean> {
  return withWorkspaceLock(projectRoot, async () => {
    const workspace = await ensureMigratedUnlocked(projectRoot);
    if (workspace.hostSessionId !== expectedSessionId) return false;
    await atomicWriteJSON(
      getWorkspaceFilePath(projectRoot),
      {
        schemaVersion: workspace.schemaVersion,
        workspaceId: workspace.workspaceId,
        nextRunSequence: workspace.nextRunSequence,
      },
      { noFollow: true },
    );
    return true;
  });
}

export async function readMeshAgents(
  projectRoot: string,
): Promise<MeshAgent[]> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    transaction.readAgents(),
  );
}

export async function updateMeshAgents(
  projectRoot: string,
  mutate: (agents: MeshAgent[]) => MeshAgent[],
): Promise<MeshAgent[]> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const next = mutate(agents);
    if (next !== agents) await transaction.writeAgents(next);
    return next;
  });
}

type MeshAgentRosterChange = 'updated' | 'not_found' | 'has_live_work';

async function agentHasLiveWork(
  transaction: MeshStoreTransaction,
  agentId: string,
): Promise<boolean> {
  const { threads, unreadable } = await transaction.listThreads();
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot change the agent roster while thread records are unreadable: ${unreadable.join(', ')}.`,
    );
  }
  return threads.some((thread) =>
    thread.runs.some(
      (run) =>
        run.agentId === agentId &&
        (run.status === 'queued' ||
          run.status === 'running' ||
          run.status === 'finishing' ||
          run.status === 'cancelling'),
    ),
  );
}

export async function setMeshAgentEnabled(
  projectRoot: string,
  agentId: string,
  enabled: boolean,
): Promise<MeshAgentRosterChange> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return 'not_found';
    if ((agent.enabled !== false) === enabled) return 'updated';
    await transaction.writeAgents(
      agents.map((candidate) =>
        candidate.id === agentId ? { ...candidate, enabled } : candidate,
      ),
    );
    return 'updated';
  });
}

export async function removeMeshAgent(
  projectRoot: string,
  agentId: string,
): Promise<MeshAgentRosterChange> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    if (!agents.some((candidate) => candidate.id === agentId)) {
      return 'not_found';
    }
    if (await agentHasLiveWork(transaction, agentId)) return 'has_live_work';
    await transaction.writeAgents(
      agents.filter((candidate) => candidate.id !== agentId),
    );
    return 'updated';
  });
}

export function findAgentByName(
  agents: readonly MeshAgent[],
  name: string,
): MeshAgent | undefined {
  const lowered = name.toLowerCase();
  return agents.find((agent) => agent.name.toLowerCase() === lowered);
}

export function isAgentEnabled(agent: MeshAgent): boolean {
  return agent.enabled !== false;
}

/** How many threads this agent may work at once. Absent means one. */
export function maxConcurrentRunsFor(agent: MeshAgent): number {
  return agent.maxConcurrentRuns ?? 1;
}

/**
 * Whether this identity can still be given work.
 *
 * Retired and disabled are different refusals with the same answer here, and
 * both are kept apart from "unknown": a retired agent's name still resolves, so
 * a post that mentions it gets `agent_disabled` and a person is told the agent
 * is gone rather than that they mistyped.
 */
export function isAgentAddressable(agent: MeshAgent): boolean {
  return agent.retiredAt === undefined && agent.enabled !== false;
}

export function queueLimitFor(agent: MeshAgent): number {
  return agent.queueLimit ?? DEFAULT_QUEUE_LIMIT;
}

export async function listThreadIds(projectRoot: string): Promise<string[]> {
  return withMeshStoreTransaction(projectRoot, () =>
    listThreadIdsUnlocked(projectRoot),
  );
}

export async function readThread(
  projectRoot: string,
  threadId: string,
): Promise<Thread | undefined> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    transaction.readThread(threadId),
  );
}

export async function listThreads(
  projectRoot: string,
): Promise<{ threads: Thread[]; unreadable: string[] }> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    transaction.listThreads(),
  );
}

export async function writeThread(
  projectRoot: string,
  thread: Thread,
): Promise<void> {
  await withMeshStoreTransaction(projectRoot, async (transaction) => {
    await transaction.writeThread(thread);
  });
}

export async function updateThread(
  projectRoot: string,
  threadId: string,
  mutate: (thread: Thread) => Thread,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread) throw new Error(`No thread with id "${threadId}".`);
    const next = mutate(thread);
    if (next.id !== threadId) {
      throw new Error('A thread update cannot change its id.');
    }
    return next === thread ? thread : transaction.writeThread(next);
  });
}

export interface CreateThreadInput {
  title: string;
  body?: string;
  createdBy?: string;
  assigneeAgentId?: string;
  parentThreadId?: string;
}

/**
 * Creates a thread inside an open transaction.
 *
 * Use `prepareThreadInTransaction` when the first message and run must be part
 * of the initial file replacement too.
 */
export async function createThreadInTransaction(
  transaction: MeshStoreTransaction,
  input: CreateThreadInput,
): Promise<Thread> {
  return transaction.writeThread(
    await prepareThreadInTransaction(transaction, input),
  );
}

export async function prepareThreadInTransaction(
  transaction: MeshStoreTransaction,
  input: CreateThreadInput,
): Promise<Thread> {
  const id = generateThreadId();
  let rootThreadId = id;
  let autoTurnsUsed = 0;
  if (input.parentThreadId) {
    const parent = await transaction.readThread(input.parentThreadId);
    if (!parent) {
      throw new Error(`No parent thread with id "${input.parentThreadId}".`);
    }
    rootThreadId = parent.rootThreadId;
    autoTurnsUsed = parent.autoTurnsUsed;
    const root = await transaction.readThread(rootThreadId);
    if (!root || root.rootThreadId !== root.id) {
      throw new Error(`No valid root thread with id "${rootThreadId}".`);
    }
  }
  return {
    schemaVersion: MESH_SCHEMA_VERSION,
    id,
    title: input.title,
    body: input.body ?? '',
    status: 'open',
    createdAt: Date.now(),
    createdBy: input.createdBy ?? HUMAN_AUTHOR_ID,
    rootThreadId,
    messages: [],
    runs: [],
    nextMessageSequence: 1,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed,
    tokensUsed: 0,
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.assigneeAgentId
      ? { assigneeAgentId: input.assigneeAgentId }
      : {}),
  };
}

export async function createThread(
  projectRoot: string,
  input: CreateThreadInput,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    createThreadInTransaction(transaction, input),
  );
}

export async function readTokenBudgetThread(
  projectRoot: string,
  thread: Thread,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const root = await transaction.readThread(thread.rootThreadId);
    if (!root || root.rootThreadId !== root.id) {
      throw new Error(
        `No valid root thread with id "${thread.rootThreadId}" for "${thread.id}".`,
      );
    }
    return {
      ...root,
      tokensUsed: await transaction.threadTreeTokens(root.id),
    };
  });
}

export async function allocateRunSequence(
  projectRoot: string,
): Promise<number> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    transaction.allocateRunSequence(),
  );
}

export async function deleteThread(
  projectRoot: string,
  threadId: string,
): Promise<boolean> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread) return false;
    if (
      thread.runs.some(
        (run) =>
          run.status === 'queued' ||
          run.status === 'running' ||
          run.status === 'finishing' ||
          run.status === 'cancelling',
      )
    ) {
      throw new Error(`Cannot delete thread "${threadId}" with active runs.`);
    }
    if (thread.outbox.some((event) => event.status === 'pending')) {
      throw new Error(
        `Cannot delete thread "${threadId}" with pending events.`,
      );
    }
    const { threads, unreadable } = await transaction.listThreads();
    if (unreadable.length > 0) {
      throw new Error(
        `Cannot safely delete thread "${threadId}" while thread records are unreadable.`,
      );
    }
    if (
      threads.some(
        (candidate) =>
          candidate.id !== threadId &&
          (candidate.parentThreadId === threadId ||
            (thread.rootThreadId === thread.id &&
              candidate.rootThreadId === thread.id)),
      )
    ) {
      throw new Error(`Cannot delete thread "${threadId}" with sub-threads.`);
    }
    return transaction.deleteThreadFile(threadId);
  });
}

export async function enqueueThreadEvent(
  projectRoot: string,
  threadId: string,
  event: Omit<ThreadEvent, 'id' | 'status' | 'attempts' | 'createdAt'> & {
    id?: string;
    createdAt?: number;
  },
): Promise<ThreadEvent> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread) throw new Error(`No thread with id "${threadId}".`);
    const stored: ThreadEvent = {
      ...event,
      id: event.id ?? generateEventId(),
      status: 'pending',
      attempts: 0,
      createdAt: event.createdAt ?? Date.now(),
    };
    await transaction.writeThread({
      ...thread,
      outbox: [...thread.outbox, stored],
    });
    return stored;
  });
}

export async function reconcileThreadOutbox(
  projectRoot: string,
  threadId: string,
  apply: (
    transaction: MeshStoreTransaction,
    event: ThreadEvent,
  ) => Promise<void>,
  /**
   * Which pending events this pass owns. An event no consumer claims is left
   * pending rather than acknowledged, so a kind whose consumer does not exist
   * yet is visibly outstanding instead of silently dropped.
   */
  filter: (event: ThreadEvent) => boolean = () => true,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    let source = await transaction.readThread(threadId);
    if (!source) throw new Error(`No thread with id "${threadId}".`);
    for (const event of source.outbox) {
      if (event.status !== 'pending' || !filter(event)) continue;
      const attempted = { ...event, attempts: event.attempts + 1 };
      source = await transaction.writeThread({
        ...source,
        outbox: source.outbox.map((candidate) =>
          candidate.id === event.id ? attempted : candidate,
        ),
      });
      await apply(transaction, attempted);
      source = (await transaction.readThread(threadId)) ?? source;
      source = await transaction.writeThread({
        ...source,
        outbox: source.outbox.map((candidate) =>
          candidate.id === event.id
            ? { ...candidate, status: 'acknowledged' }
            : candidate,
        ),
      });
    }
    return source;
  });
}
