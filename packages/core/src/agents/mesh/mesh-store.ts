/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview File I/O for the agent mesh.
 *
 * Layout, under the per-project runtime dir (`~/.qwen/tmp/<project-hash>/`)
 * rather than the working tree — the same reasoning the durable scheduled
 * tasks file records: this is the user's own automation state, and thread
 * text written by one agent is fed to another, so it must never become a
 * committed, pulled, prompt-injection surface.
 *
 *   mesh/agents.json          — the workspace's agent identities
 *   mesh/threads/<id>.json    — one file per thread
 *
 * Concurrency follows the team modules: an in-process `Mutex` serialises
 * writers here, and a `proper-lockfile` lock guards writers in other
 * processes (the daemon, a CLI session, and a teammate can all post).
 *
 * A file that exists but does not parse is corruption, not emptiness. Reads
 * throw rather than returning a default, so a read-modify-write can never
 * replace a recoverable file with a valid-but-empty one.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import lockfile from 'proper-lockfile';

import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { getProjectHash } from '../../utils/paths.js';
import { Storage } from '../../config/storage.js';
import { isNodeError } from '../../utils/errors.js';
import {
  DEFAULT_QUEUE_LIMIT,
  HUMAN_AUTHOR_ID,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_RUNS,
  type MeshAgent,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
  type ThreadRunStatus,
  type ThreadStatus,
} from './types.js';

const MESH_DIRNAME = 'mesh';
const AGENTS_FILENAME = 'agents.json';
const THREADS_DIRNAME = 'threads';

/** Display form used in user-facing messages and docs. */
export const MESH_DISPLAY_PATH = `~/.qwen/tmp/<project-hash>/${MESH_DIRNAME}`;

// Matches the team mailbox's settings: ten retries with jittered backoff.
// Jitter matters because the daemon dispatcher and an agent's `thread_post`
// contend for the same thread file, and lockstep retries starve each other
// out of the budget.
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    randomize: true,
  },
  stale: 10_000,
};

const updateMutexes = new Map<string, Mutex>();

function getUpdateMutex(filePath: string): Mutex {
  let mutex = updateMutexes.get(filePath);
  if (!mutex) {
    mutex = new Mutex();
    updateMutexes.set(filePath, mutex);
  }
  return mutex;
}

export function getMeshDir(projectRoot: string): string {
  return path.join(
    Storage.getGlobalTempDir(),
    getProjectHash(projectRoot),
    MESH_DIRNAME,
  );
}

export function getAgentsFilePath(projectRoot: string): string {
  return path.join(getMeshDir(projectRoot), AGENTS_FILENAME);
}

export function getThreadsDir(projectRoot: string): string {
  return path.join(getMeshDir(projectRoot), THREADS_DIRNAME);
}

/**
 * Thread ids are path components, so they are generated — never taken from a
 * caller — and validated on the way back in. `..`, separators and control
 * characters can therefore never reach `path.join`.
 */
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

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function getThreadPath(projectRoot: string, threadId: string): string {
  if (!isValidId(threadId)) {
    throw new Error(`Invalid thread id: ${JSON.stringify(threadId)}`);
  }
  return path.join(getThreadsDir(projectRoot), `${threadId}.json`);
}

// ─── Validation ─────────────────────────────────────────────

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Names are the mention vocabulary, so the character set is deliberately
 * narrow: whatever is legal here has to be unambiguously delimitable inside
 * prose after an `@`.
 */
export const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u;

export function isValidAgentName(value: unknown): value is string {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}

function isValidAgent(value: unknown): value is MeshAgent {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    isValidId(a['id']) &&
    isValidAgentName(a['name']) &&
    isFiniteTimestamp(a['createdAt']) &&
    (a['description'] === undefined || typeof a['description'] === 'string') &&
    (a['color'] === undefined ||
      (typeof a['color'] === 'string' && HEX_COLOR.test(a['color']))) &&
    (a['agentType'] === undefined || isNonEmptyString(a['agentType'])) &&
    (a['model'] === undefined || isNonEmptyString(a['model'])) &&
    (a['queueLimit'] === undefined ||
      (typeof a['queueLimit'] === 'number' &&
        Number.isInteger(a['queueLimit']) &&
        a['queueLimit'] > 0)) &&
    (a['enabled'] === undefined || typeof a['enabled'] === 'boolean') &&
    (a['backgroundAgentId'] === undefined ||
      isNonEmptyString(a['backgroundAgentId'])) &&
    (a['hostSessionId'] === undefined || isNonEmptyString(a['hostSessionId']))
  );
}

const RUN_STATUSES = new Set<ThreadRunStatus>([
  'queued',
  'running',
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

function isValidMessage(value: unknown): value is ThreadMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    isValidId(m['id']) &&
    isNonEmptyString(m['from']) &&
    typeof m['text'] === 'string' &&
    Array.isArray(m['mentions']) &&
    m['mentions'].every((id) => isValidId(id)) &&
    isFiniteTimestamp(m['at'])
  );
}

function isValidRun(value: unknown): value is ThreadRun {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    isValidId(r['id']) &&
    isValidId(r['agentId']) &&
    RUN_STATUSES.has(r['status'] as ThreadRunStatus) &&
    typeof r['attempts'] === 'number' &&
    Number.isInteger(r['attempts']) &&
    r['attempts'] >= 0 &&
    Array.isArray(r['triggerMessageIds']) &&
    r['triggerMessageIds'].every((id) => isValidId(id)) &&
    isFiniteTimestamp(r['queuedAt']) &&
    (r['sessionId'] === undefined || isNonEmptyString(r['sessionId'])) &&
    (r['startedAt'] === undefined || isFiniteTimestamp(r['startedAt'])) &&
    (r['endedAt'] === undefined || isFiniteTimestamp(r['endedAt'])) &&
    (r['error'] === undefined || typeof r['error'] === 'string')
  );
}

function isValidThread(value: unknown): value is Thread {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    isValidId(t['id']) &&
    typeof t['title'] === 'string' &&
    typeof t['body'] === 'string' &&
    THREAD_STATUSES.has(t['status'] as ThreadStatus) &&
    isFiniteTimestamp(t['createdAt']) &&
    isNonEmptyString(t['createdBy']) &&
    Array.isArray(t['messages']) &&
    t['messages'].every(isValidMessage) &&
    Array.isArray(t['runs']) &&
    t['runs'].every(isValidRun) &&
    typeof t['autoTurnsUsed'] === 'number' &&
    Number.isInteger(t['autoTurnsUsed']) &&
    t['autoTurnsUsed'] >= 0 &&
    typeof t['tokensUsed'] === 'number' &&
    Number.isInteger(t['tokensUsed']) &&
    t['tokensUsed'] >= 0 &&
    isValidId(t['rootThreadId']) &&
    (t['parentThreadId'] === undefined || isValidId(t['parentThreadId'])) &&
    (t['assigneeAgentId'] === undefined || isValidId(t['assigneeAgentId']))
  );
}

// ─── Agents ─────────────────────────────────────────────────

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as empty.`,
    );
  }
}

export async function readMeshAgents(
  projectRoot: string,
): Promise<MeshAgent[]> {
  const filePath = getAgentsFilePath(projectRoot);
  const parsed = await readJsonFile(filePath);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON array in ${filePath} — fix or delete the file; refusing to treat it as no agents.`,
    );
  }
  // One malformed entry must not hide the rest: an unreadable agent is
  // dropped from the roster, exactly as the board listing skips a bad record,
  // while a corrupt *file* still throws above.
  return parsed.filter(isValidAgent);
}

async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // proper-lockfile needs the target to exist before it can lock it.
  try {
    await fs.access(filePath);
  } catch {
    await atomicWriteJSON(
      filePath,
      filePath.endsWith(AGENTS_FILENAME) ? [] : {},
      {
        noFollow: true,
      },
    );
  }
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function updateMeshAgents(
  projectRoot: string,
  mutate: (agents: MeshAgent[]) => MeshAgent[],
): Promise<MeshAgent[]> {
  const filePath = getAgentsFilePath(projectRoot);
  return getUpdateMutex(filePath).runExclusive(async () =>
    withFileLock(filePath, async () => {
      const agents = await readMeshAgents(projectRoot);
      const next = mutate(agents);
      if (next !== agents) {
        await atomicWriteJSON(filePath, next, { noFollow: true });
      }
      return next;
    }),
  );
}

/** Case-insensitive: mention routing must not depend on capitalisation. */
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

export function queueLimitFor(agent: MeshAgent): number {
  return agent.queueLimit ?? DEFAULT_QUEUE_LIMIT;
}

// ─── Threads ────────────────────────────────────────────────

export async function listThreadIds(projectRoot: string): Promise<string[]> {
  const dir = getThreadsDir(projectRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidId);
}

export async function readThread(
  projectRoot: string,
  threadId: string,
): Promise<Thread | undefined> {
  const parsed = await readJsonFile(getThreadPath(projectRoot, threadId));
  if (parsed === undefined) return undefined;
  if (!isValidThread(parsed)) {
    throw new Error(
      `Malformed thread record in ${getThreadPath(projectRoot, threadId)} — fix or delete the file.`,
    );
  }
  // The id in the file wins over the filename only if they agree; a mismatch
  // means the file was moved or hand-edited, and silently trusting either
  // one would let a thread answer to two ids.
  if (parsed.id !== threadId) {
    throw new Error(
      `Thread id mismatch: file ${threadId}.json contains id ${parsed.id}.`,
    );
  }
  return parsed;
}

/** Reads every thread, skipping (and reporting) ones that fail validation. */
export async function listThreads(
  projectRoot: string,
): Promise<{ threads: Thread[]; unreadable: string[] }> {
  const ids = await listThreadIds(projectRoot);
  const threads: Thread[] = [];
  const unreadable: string[] = [];
  for (const id of ids) {
    try {
      const thread = await readThread(projectRoot, id);
      if (thread) threads.push(thread);
    } catch {
      unreadable.push(id);
    }
  }
  threads.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return { threads, unreadable };
}

export async function writeThread(
  projectRoot: string,
  thread: Thread,
): Promise<void> {
  const filePath = getThreadPath(projectRoot, thread.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, trimThread(thread), { noFollow: true });
}

/**
 * Drops the oldest terminal history past the retention bounds. Messages and
 * runs still needed by queued/running work are retained even if that exceeds a
 * bound; retention must not break a live run's durable trigger references.
 */
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
      run.status === 'queued' ||
      run.status === 'running',
  );
  const referencedMessageIds = new Set(
    retainedRuns.flatMap((run) => run.triggerMessageIds),
  );
  return {
    ...thread,
    messages: thread.messages.filter(
      (message, index) =>
        index >= firstRetainedMessage || referencedMessageIds.has(message.id),
    ),
    runs: retainedRuns,
  };
}

export async function updateThread(
  projectRoot: string,
  threadId: string,
  mutate: (thread: Thread) => Thread,
): Promise<Thread> {
  const filePath = getThreadPath(projectRoot, threadId);
  return getUpdateMutex(filePath).runExclusive(async () =>
    withFileLock(filePath, async () => {
      const thread = await readThread(projectRoot, threadId);
      if (!thread) throw new Error(`No thread with id "${threadId}".`);
      const next = mutate(thread);
      if (next !== thread) await writeThread(projectRoot, next);
      return next;
    }),
  );
}

export async function createThread(
  projectRoot: string,
  input: {
    title: string;
    body?: string;
    createdBy?: string;
    assigneeAgentId?: string;
    /** Set when an agent splits work out of a thread it is already on. */
    parentThreadId?: string;
  },
): Promise<Thread> {
  const id = generateThreadId();
  // The root is inherited, not recomputed, so a chain of sub-threads keeps
  // spending one budget however deep it goes. Resolving it by walking parents
  // at spend time would make the budget depend on files that may be missing.
  let rootThreadId = id;
  let autoTurnsUsed = 0;
  if (input.parentThreadId) {
    const parent = await readThread(projectRoot, input.parentThreadId);
    if (!parent) {
      throw new Error(`No parent thread with id "${input.parentThreadId}".`);
    }
    rootThreadId = parent.rootThreadId;
    autoTurnsUsed = parent.autoTurnsUsed;
    if (rootThreadId !== parent.id) {
      const root = await readThread(projectRoot, rootThreadId);
      if (!root || root.rootThreadId !== root.id) {
        throw new Error(`No valid root thread with id "${rootThreadId}".`);
      }
    }
  }
  const thread: Thread = {
    id,
    title: input.title,
    body: input.body ?? '',
    status: 'open',
    createdAt: Date.now(),
    createdBy: input.createdBy ?? HUMAN_AUTHOR_ID,
    rootThreadId,
    messages: [],
    runs: [],
    autoTurnsUsed,
    tokensUsed: 0,
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.assigneeAgentId
      ? { assigneeAgentId: input.assigneeAgentId }
      : {}),
  };
  await writeThread(projectRoot, thread);
  return thread;
}

/**
 * Reads the record a thread's budget is spent from. A root thread is its own.
 *
 * Fails closed when the root is absent or invalid. A child carries less token
 * spend than the tree, so falling back to it would weaken the budget gate.
 */
export async function readTokenBudgetThread(
  projectRoot: string,
  thread: Thread,
): Promise<Thread> {
  if (thread.rootThreadId === thread.id) return thread;
  const root = await readThread(projectRoot, thread.rootThreadId);
  if (!root || root.rootThreadId !== root.id) {
    throw new Error(
      `No valid root thread with id "${thread.rootThreadId}" for "${thread.id}".`,
    );
  }
  return root;
}

export async function deleteThread(
  projectRoot: string,
  threadId: string,
): Promise<boolean> {
  const thread = await readThread(projectRoot, threadId);
  if (!thread) return false;
  if (
    thread.runs.some(
      (run) => run.status === 'queued' || run.status === 'running',
    )
  ) {
    throw new Error(`Cannot delete thread "${threadId}" with active runs.`);
  }
  const { threads, unreadable } = await listThreads(projectRoot);
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
  try {
    await fs.unlink(getThreadPath(projectRoot, threadId));
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}
