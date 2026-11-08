/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-chat-session agent state: bindings and runs.
 *
 * One file per chat session at `<agentsDir>/sessions/<sessionId>.json`, mode
 * 0600, written under the same workspace lock as the agent roster. The daemon
 * orchestrator is the only writer; the ACP child reads it (unlocked — writes
 * are atomic renames) to authorize a hidden agent session.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import {
  STORE_DIR_MODE,
  STORE_FILE_OPTIONS,
  getAgentsDir,
  withAgentStoreTransaction,
} from '../workspace-agents/store.js';
import {
  SESSION_AGENTS_SCHEMA_VERSION,
  type SessionAgentBinding,
  type SessionAgentRun,
  type SessionAgentRunStatus,
  type SessionAgentsFile,
  type SessionSquadEngagement,
} from './contract.js';

const SESSIONS_DIRNAME = 'sessions';

/** Terminal runs kept per session file (newest first by end time). */
export const MAX_TERMINAL_SESSION_AGENT_RUNS = 50;

/**
 * Chat session ids are UUIDs (the session JSONL pattern accepts 32-36 hex
 * digits and dashes). Anything else could escape the sessions directory.
 */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{32,36}$/;

/**
 * Upper bound on files read when looking up which chat session planned a
 * native session id.
 * TODO(multi-agent): replace the scan with an index of sessions that have a
 * live run (session-multi-agent design §4.1).
 */
const MAX_BINDING_SCAN_FILES = 5_000;

const LIVE_RUN_STATUSES: ReadonlySet<SessionAgentRunStatus> = new Set([
  'queued',
  'running',
  'awaiting_approval',
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<SessionAgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'offline',
]);

/** Statuses in which a native session is being driven for this run. */
const EXECUTING_RUN_STATUSES: ReadonlySet<SessionAgentRunStatus> = new Set([
  'running',
  'awaiting_approval',
]);

export function isValidSessionAgentsSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function isTerminalSessionAgentRunStatus(
  status: SessionAgentRunStatus,
): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function getSessionAgentsDir(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), SESSIONS_DIRNAME);
}

export function getSessionAgentsFilePath(
  projectRoot: string,
  sessionId: string,
): string {
  if (!isValidSessionAgentsSessionId(sessionId)) {
    throw new Error(`Invalid chat session id: ${JSON.stringify(sessionId)}`);
  }
  return path.join(getSessionAgentsDir(projectRoot), `${sessionId}.json`);
}

export function emptySessionAgentsFile(sessionId: string): SessionAgentsFile {
  return {
    schemaVersion: SESSION_AGENTS_SCHEMA_VERSION,
    sessionId,
    bindings: {},
    runs: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isFinite(value))
  );
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  ...LIVE_RUN_STATUSES,
  ...TERMINAL_RUN_STATUSES,
]);

function isValidBinding(value: unknown): value is SessionAgentBinding {
  return (
    isRecord(value) &&
    typeof value['agentId'] === 'string' &&
    isOptionalString(value['nativeSessionId']) &&
    isOptionalString(value['runtimeId']) &&
    (value['program'] === undefined ||
      value['program'] === 'qwen' ||
      value['program'] === 'claude' ||
      value['program'] === 'codex') &&
    isOptionalString(value['readThroughRecordId']) &&
    (value['remotePersona'] === undefined ||
      (isRecord(value['remotePersona']) &&
        typeof value['remotePersona']['name'] === 'string' &&
        isOptionalString(value['remotePersona']['instructions']) &&
        isOptionalString(value['remotePersona']['model'])))
  );
}

function isValidLease(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value['hostId'] === 'string' &&
      typeof value['leaseId'] === 'string' &&
      typeof value['attempt'] === 'number' &&
      typeof value['expiresAt'] === 'number' &&
      isOptionalFiniteNumber(value['lastSequence']))
  );
}

function isValidRun(value: unknown): value is SessionAgentRun {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['agentId'] === 'string' &&
    typeof value['status'] === 'string' &&
    RUN_STATUSES.has(value['status']) &&
    Array.isArray(value['triggerRecordIds']) &&
    value['triggerRecordIds'].every((id) => typeof id === 'string') &&
    typeof value['chainDepth'] === 'number' &&
    typeof value['createdAt'] === 'number' &&
    typeof value['attempts'] === 'number' &&
    isOptionalFiniteNumber(value['startedAt']) &&
    isOptionalFiniteNumber(value['endedAt']) &&
    isOptionalString(value['error']) &&
    isOptionalFiniteNumber(value['totalTokens']) &&
    isOptionalString(value['retryOf']) &&
    isOptionalString(value['squadId']) &&
    (value['recorded'] === undefined ||
      typeof value['recorded'] === 'boolean') &&
    isValidLease(value['lease'])
  );
}

function isValidEngagement(value: unknown): value is SessionSquadEngagement {
  return (
    isRecord(value) &&
    typeof value['leaderAgentId'] === 'string' &&
    typeof value['startedByRecordId'] === 'string' &&
    Array.isArray(value['outstandingRunIds']) &&
    value['outstandingRunIds'].every((id) => typeof id === 'string') &&
    (value['pendingWakeRunIds'] === undefined ||
      (Array.isArray(value['pendingWakeRunIds']) &&
        value['pendingWakeRunIds'].every((id) => typeof id === 'string'))) &&
    typeof value['active'] === 'boolean'
  );
}

function isValidEngagements(
  value: unknown,
): value is Record<string, SessionSquadEngagement> | undefined {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every(isValidEngagement))
  );
}

/**
 * Parses a file read from disk. Refuses rather than repairs: a file this
 * build cannot read is reported, never silently treated as empty, because
 * an empty file would drop every binding (and every resume pointer) in it.
 */
export function parseSessionAgentsFile(
  value: unknown,
  sessionId: string,
  filePath = '<memory>',
): SessionAgentsFile {
  if (!isRecord(value)) {
    throw new Error(`Malformed session agents file ${filePath}.`);
  }
  if (value['schemaVersion'] !== SESSION_AGENTS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported session agents schema version ${JSON.stringify(value['schemaVersion'])} in ${filePath}; this build supports version ${SESSION_AGENTS_SCHEMA_VERSION}.`,
    );
  }
  if (value['sessionId'] !== sessionId) {
    throw new Error(
      `Session agents file ${filePath} names session ${JSON.stringify(value['sessionId'])}, not ${sessionId}.`,
    );
  }
  const bindings = value['bindings'];
  const runs = value['runs'];
  if (
    !isRecord(bindings) ||
    !Object.entries(bindings).every(
      ([agentId, binding]) =>
        isValidBinding(binding) && binding.agentId === agentId,
    ) ||
    !Array.isArray(runs) ||
    !runs.every(isValidRun) ||
    !isValidEngagements(value['squads'])
  ) {
    throw new Error(`Malformed session agents file ${filePath}.`);
  }
  const squads = value['squads'] as
    | Record<string, SessionSquadEngagement>
    | undefined;
  return {
    schemaVersion: SESSION_AGENTS_SCHEMA_VERSION,
    sessionId,
    bindings: bindings as Record<string, SessionAgentBinding>,
    runs: runs as SessionAgentRun[],
    ...(typeof value['chainTokens'] === 'number' &&
    Number.isFinite(value['chainTokens']) &&
    value['chainTokens'] > 0
      ? { chainTokens: value['chainTokens'] }
      : {}),
    ...(squads && Object.keys(squads).length > 0 ? { squads } : {}),
  };
}

/**
 * Keeps every live run and the newest `max` terminal runs, in the original
 * order. "Newest" is by end time, falling back to creation time.
 */
export function trimTerminalRuns(
  runs: readonly SessionAgentRun[],
  max = MAX_TERMINAL_SESSION_AGENT_RUNS,
): SessionAgentRun[] {
  // A terminal run whose reply never reached the transcript is still owed
  // (a retry, a pending record, a squad leader waiting on it), so it is
  // never trimmed; only settled history is.
  const terminal = runs.filter(
    (run) =>
      isTerminalSessionAgentRunStatus(run.status) && run.recorded !== false,
  );
  if (terminal.length <= max) return [...runs];
  const keep = new Set(
    [...terminal]
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
      .slice(0, Math.max(0, max))
      .map((run) => run.id),
  );
  return runs.filter(
    (run) =>
      !isTerminalSessionAgentRunStatus(run.status) ||
      run.recorded === false ||
      keep.has(run.id),
  );
}

async function readFileUnlocked(
  projectRoot: string,
  sessionId: string,
): Promise<SessionAgentsFile | undefined> {
  const filePath = getSessionAgentsFilePath(projectRoot, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${filePath} — fix or delete the file; refusing to treat it as empty.`,
    );
  }
  return parseSessionAgentsFile(parsed, sessionId, filePath);
}

/**
 * Reads one chat session's agent state. Absent means no agent has been
 * addressed in that session yet, which is an empty file, not an error.
 */
export async function readSessionAgents(
  projectRoot: string,
  sessionId: string,
): Promise<SessionAgentsFile> {
  return (
    (await readFileUnlocked(projectRoot, sessionId)) ??
    emptySessionAgentsFile(sessionId)
  );
}

/**
 * Read-modify-write under the workspace lock. `mutate` may edit the file in
 * place or return a replacement. Terminal runs are trimmed on every write.
 *
 * Must not be called from inside another agent store transaction: the
 * workspace lock refuses to nest.
 */
export async function updateSessionAgents(
  projectRoot: string,
  sessionId: string,
  mutate: (file: SessionAgentsFile) => SessionAgentsFile | void,
): Promise<SessionAgentsFile> {
  const filePath = getSessionAgentsFilePath(projectRoot, sessionId);
  return withAgentStoreTransaction(projectRoot, async () => {
    const current =
      (await readFileUnlocked(projectRoot, sessionId)) ??
      emptySessionAgentsFile(sessionId);
    const mutated =
      (mutate(current) as SessionAgentsFile | undefined) ?? current;
    const next: SessionAgentsFile = {
      schemaVersion: SESSION_AGENTS_SCHEMA_VERSION,
      sessionId,
      bindings: mutated.bindings,
      runs: trimTerminalRuns(mutated.runs),
      ...(mutated.chainTokens ? { chainTokens: mutated.chainTokens } : {}),
      ...(mutated.squads && Object.keys(mutated.squads).length > 0
        ? { squads: mutated.squads }
        : {}),
    };
    // Validate what is about to be written with the same rules a read uses,
    // so a bad in-memory value fails here rather than wedging the next read.
    parseSessionAgentsFile(next, sessionId, filePath);
    await fs.mkdir(getSessionAgentsDir(projectRoot), {
      recursive: true,
      mode: STORE_DIR_MODE,
    });
    await atomicWriteJSON(filePath, next, STORE_FILE_OPTIONS);
    return next;
  });
}

/** Writes a whole file (the orchestrator's in-memory state) under the lock. */
export async function writeSessionAgents(
  projectRoot: string,
  file: SessionAgentsFile,
): Promise<SessionAgentsFile> {
  return updateSessionAgents(projectRoot, file.sessionId, () => ({
    ...file,
    bindings: structuredClone(file.bindings),
    runs: structuredClone(file.runs),
    ...(file.chainTokens ? { chainTokens: file.chainTokens } : {}),
    ...(file.squads ? { squads: structuredClone(file.squads) } : {}),
  }));
}

/** Ids of every chat session that has a session agents file. */
export async function listSessionAgentsSessionIds(
  projectRoot: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(getSessionAgentsDir(projectRoot));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidSessionAgentsSessionId);
}

export interface SessionAgentNativeBinding {
  /** The chat session whose agent this native session serves. */
  chatSessionId: string;
  agentId: string;
  runId: string;
  status: SessionAgentRunStatus;
  /** Present when this daemon runs the turn as a remote Host (see contract). */
  remotePersona?: SessionAgentBinding['remotePersona'];
}

/**
 * Whether `nativeSessionId` is the native (hidden ACP) session a live run in
 * some chat session is driving for `agentId`.
 *
 * The session-agents counterpart of `findAgentSessionBinding`: `sourceType`
 * and `sourceId` on a session request are claims, and what makes one true is
 * that the orchestrator persisted a binding naming this session for this
 * agent AND a run of that agent is executing. The orchestrator writes both
 * before it spawns or resumes the session.
 *
 * Unreadable files are skipped: one corrupt chat session must not stop every
 * other session's agents from starting.
 */
export async function findSessionAgentBinding(
  projectRoot: string,
  nativeSessionId: string | undefined,
  agentId: string,
): Promise<SessionAgentNativeBinding | undefined> {
  if (!nativeSessionId || !agentId) return undefined;
  const ids = (await listSessionAgentsSessionIds(projectRoot)).slice(
    0,
    MAX_BINDING_SCAN_FILES,
  );
  for (const chatSessionId of ids) {
    let file: SessionAgentsFile | undefined;
    try {
      file = await readFileUnlocked(projectRoot, chatSessionId);
    } catch {
      continue;
    }
    if (!file) continue;
    const binding = file.bindings[agentId];
    if (binding?.nativeSessionId !== nativeSessionId) continue;
    const run = file.runs.find(
      (candidate) =>
        candidate.agentId === agentId &&
        EXECUTING_RUN_STATUSES.has(candidate.status) &&
        // A remote run executes on its host, never in this daemon's child.
        candidate.lease === undefined,
    );
    if (!run) continue;
    return {
      chatSessionId,
      agentId,
      runId: run.id,
      status: run.status,
      ...(binding.remotePersona
        ? { remotePersona: { ...binding.remotePersona } }
        : {}),
    };
  }
  return undefined;
}

/**
 * Whether an agent's native session (and with it the read cursor) can be
 * reused for a turn on `runtimeId` with `program`. A native session lives on
 * one runtime and belongs to one program; anywhere else the agent starts a
 * fresh session that has seen nothing, so it must be given the conversation
 * from the start (bounded by the input budget) instead of the delta after
 * the old cursor. A binding that never recorded a runtime has no native
 * session yet, so the cursor stands.
 */
export function canReuseNativeSession(
  binding: Pick<SessionAgentBinding, 'runtimeId' | 'program'>,
  runtimeId: string,
  program: SessionAgentBinding['program'],
): boolean {
  return (
    (binding.runtimeId === undefined || binding.runtimeId === runtimeId) &&
    (binding.program === undefined || binding.program === program)
  );
}
