/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Which external tasks belong to which caller.
 *
 * The protocol half of A2A is frozen in `a2a-contract.ts`; this is the store
 * half. An external task is an agent run in a chat session (see the contract),
 * and neither the session nor the run knows who outside asked for it, so this
 * file is what does: one JSON file per caller at `<agentsDir>/a2a/<callerId>.json`,
 * mode 0600, written under the workspace lock. It has to get two things right,
 * both about persistence rather than about A2A:
 *
 *   - a retry must not produce a second piece of work, and
 *   - one caller must not be able to read, steer or continue another's.
 *
 * Accepting work is three steps, because starting the run cannot happen
 * inside the lock (the orchestrator persists runs under the same lock, which
 * refuses to nest): reserve the request key, then create the session and post
 * the message outside the lock, then record the run. A reservation without a
 * run is resumed by a retry of the same request, never duplicated.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import type { SessionAgentRunStatus } from '../session-agents/contract.js';
import { isValidSessionAgentsSessionId } from '../session-agents/binding-store.js';
import { externalRequestKey, type A2ATaskState } from './a2a-contract.js';
import {
  STORE_DIR_MODE,
  STORE_FILE_OPTIONS,
  getAgentsDir,
  isValidId,
  withAgentStoreTransaction,
} from './store.js';

const A2A_DIRNAME = 'a2a';

export const A2A_CALLER_FILE_SCHEMA_VERSION = 1 as const;

/** The first terminal view of a task, kept so it outlives the run's records. */
export interface ExternalTaskResult {
  state: A2ATaskState;
  /** Epoch ms the task reached that state. */
  at: number;
  /** The granted agent's reply. */
  answer?: string;
  error?: string;
  localStatus?: SessionAgentRunStatus;
  tokensUsed?: number;
}

/** One accepted (or reserved) external message. */
export interface ExternalTaskEntry {
  /** {@link externalRequestKey} of the request. */
  key: string;
  /** Digest of what was asked; a reused key with another digest is refused. */
  contentHash: string;
  agentId: string;
  messageId: string;
  createdAt: number;
  /** The chat session (A2A `contextId`); absent until it exists. */
  sessionId?: string;
  /**
   * The agent run (A2A task id); absent until the post was accepted. Two
   * entries share one when the second message arrived while the first run
   * was still queued: the orchestrator coalesces them into one run.
   */
  taskId?: string;
  result?: ExternalTaskResult;
}

/** A chat session the daemon created for this caller and agent. */
export interface ExternalContextEntry {
  sessionId: string;
  agentId: string;
  createdAt: number;
}

/** On disk: `<agentsDir>/a2a/<callerId>.json`, mode 0600. */
export interface ExternalCallerFile {
  schemaVersion: typeof A2A_CALLER_FILE_SCHEMA_VERSION;
  callerId: string;
  contexts: ExternalContextEntry[];
  tasks: ExternalTaskEntry[];
}

/**
 * Raised when a caller reuses a key for different content.
 *
 * Its own class because the transport has to answer this one differently from
 * every other failure: it is not "your request failed", it is "you already used
 * this id for something else", and a caller that cannot tell those apart will
 * retry forever.
 */
export class ExternalIntakeConflictError extends Error {
  constructor(
    readonly key: string,
    readonly existingTaskId: string | undefined,
  ) {
    super(
      `Request key already accepted for different content${existingTaskId ? ` (task ${existingTaskId})` : ''}`,
    );
    this.name = 'ExternalIntakeConflictError';
  }
}

/**
 * Raised for a `contextId` that is not a session this caller was given for
 * this agent. One answer for "no such session" and "someone else's".
 */
export class ExternalIntakeUnknownContextError extends Error {
  constructor() {
    super('Unknown contextId.');
    this.name = 'ExternalIntakeUnknownContextError';
  }
}

export interface ExternalSubmission {
  /** Stable id of the authenticated caller, from the transport's auth. */
  callerId: string;
  /** The local agent this work is aimed at. */
  targetAgentId: string;
  /** `Message.messageId` as the caller minted it. */
  messageId: string;
  text: string;
  /** Continue in this chat session; absent starts a new one. */
  contextId?: string;
}

export type ExternalReservation =
  /** The same request was accepted before; nothing more to do. */
  | { outcome: 'duplicate'; entry: ExternalTaskEntry }
  /** New, or a retry of a request whose run was never recorded. */
  | { outcome: 'reserved'; entry: ExternalTaskEntry };

export function getExternalCallersDir(projectRoot: string): string {
  return path.join(getAgentsDir(projectRoot), A2A_DIRNAME);
}

export function getExternalCallerFilePath(
  projectRoot: string,
  callerId: string,
): string {
  // Caller ids come from grants, which hold the same pattern; anything else
  // could escape the directory.
  if (!isValidId(callerId)) {
    throw new Error(`Invalid caller id: ${JSON.stringify(callerId)}`);
  }
  return path.join(getExternalCallersDir(projectRoot), `${callerId}.json`);
}

function emptyCallerFile(callerId: string): ExternalCallerFile {
  return {
    schemaVersion: A2A_CALLER_FILE_SCHEMA_VERSION,
    callerId,
    contexts: [],
    tasks: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidResult(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value['state'] === 'string' &&
      isFiniteNumber(value['at']) &&
      isOptionalString(value['answer']) &&
      isOptionalString(value['error']) &&
      isOptionalString(value['localStatus']) &&
      (value['tokensUsed'] === undefined ||
        isFiniteNumber(value['tokensUsed'])))
  );
}

function isValidTaskEntry(value: unknown): value is ExternalTaskEntry {
  return (
    isRecord(value) &&
    typeof value['key'] === 'string' &&
    typeof value['contentHash'] === 'string' &&
    typeof value['agentId'] === 'string' &&
    typeof value['messageId'] === 'string' &&
    isFiniteNumber(value['createdAt']) &&
    (value['sessionId'] === undefined ||
      isValidSessionAgentsSessionId(value['sessionId'])) &&
    isOptionalString(value['taskId']) &&
    isValidResult(value['result'])
  );
}

function isValidContextEntry(value: unknown): value is ExternalContextEntry {
  return (
    isRecord(value) &&
    isValidSessionAgentsSessionId(value['sessionId']) &&
    typeof value['agentId'] === 'string' &&
    isFiniteNumber(value['createdAt'])
  );
}

/**
 * Parses a caller file read from disk. Refuses rather than repairs: treating
 * an unreadable file as empty would forget every idempotency key in it, and
 * a retry would then start the work a second time.
 */
export function parseExternalCallerFile(
  value: unknown,
  callerId: string,
  filePath: string,
): ExternalCallerFile {
  if (!isRecord(value)) {
    throw new Error(`Malformed A2A caller file ${filePath}.`);
  }
  if (value['schemaVersion'] !== A2A_CALLER_FILE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported A2A caller file schema version ${JSON.stringify(value['schemaVersion'])} in ${filePath}; this build supports version ${A2A_CALLER_FILE_SCHEMA_VERSION}.`,
    );
  }
  if (value['callerId'] !== callerId) {
    throw new Error(
      `A2A caller file ${filePath} names caller ${JSON.stringify(value['callerId'])}, not ${callerId}.`,
    );
  }
  const contexts = value['contexts'];
  const tasks = value['tasks'];
  if (
    !Array.isArray(contexts) ||
    !contexts.every(isValidContextEntry) ||
    !Array.isArray(tasks) ||
    !tasks.every(isValidTaskEntry)
  ) {
    throw new Error(`Malformed A2A caller file ${filePath}.`);
  }
  return {
    schemaVersion: A2A_CALLER_FILE_SCHEMA_VERSION,
    callerId,
    contexts: contexts as ExternalContextEntry[],
    tasks: tasks as ExternalTaskEntry[],
  };
}

/**
 * One caller's file. Read without the lock: writes are atomic renames, and a
 * reader only ever needs a consistent snapshot. Absent is an empty file.
 */
export async function readExternalCallerFile(
  projectRoot: string,
  callerId: string,
): Promise<ExternalCallerFile> {
  const filePath = getExternalCallerFilePath(projectRoot, callerId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptyCallerFile(callerId);
    }
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
  return parseExternalCallerFile(parsed, callerId, filePath);
}

/**
 * Read-modify-write under the workspace lock. Must not be called from inside
 * another agent store transaction: the lock refuses to nest.
 */
async function updateExternalCallerFile<T>(
  projectRoot: string,
  callerId: string,
  mutate: (file: ExternalCallerFile) => T,
): Promise<T> {
  const filePath = getExternalCallerFilePath(projectRoot, callerId);
  return withAgentStoreTransaction(projectRoot, async () => {
    const file = await readExternalCallerFile(projectRoot, callerId);
    const result = mutate(file);
    // Validate what is about to be written with the rules a read uses, so a
    // bad in-memory value fails here rather than wedging the next read.
    parseExternalCallerFile(file, callerId, filePath);
    await fs.mkdir(getExternalCallersDir(projectRoot), {
      recursive: true,
      mode: STORE_DIR_MODE,
    });
    await atomicWriteJSON(filePath, file, STORE_FILE_OPTIONS);
    return result;
  });
}

/**
 * The digest that decides whether a repeated key is the same request.
 *
 * Length-prefixed for the same reason the key itself is: these are strings
 * from outside, and joining them with a separator would let a caller move
 * content across field boundaries without changing the digest. The context
 * is part of it: the same message id sent into another session is a
 * different request.
 */
function contentHashOf(submission: ExternalSubmission): string {
  const hash = createHash('sha256');
  for (const part of [submission.text, submission.contextId ?? '']) {
    hash.update(`${part.length}:${part}`);
  }
  return hash.digest('hex');
}

/**
 * Step 1: reserve the request key, or recognise the request as a retry.
 *
 * The lookup and the reservation are one write. Split across two, a retry
 * arriving between them would be looked up, not found, and accepted a second
 * time — which is exactly the failure the key exists to prevent.
 */
export async function reserveExternalSubmission(
  projectRoot: string,
  submission: ExternalSubmission,
): Promise<ExternalReservation> {
  const key = externalRequestKey({
    callerId: submission.callerId,
    targetAgentId: submission.targetAgentId,
    messageId: submission.messageId,
  });
  const contentHash = contentHashOf(submission);
  return updateExternalCallerFile(
    projectRoot,
    submission.callerId,
    (file): ExternalReservation => {
      const existing = file.tasks.find((entry) => entry.key === key);
      if (existing) {
        if (existing.contentHash !== contentHash) {
          throw new ExternalIntakeConflictError(key, existing.taskId);
        }
        // Deliberately does not post the message again. A retry means the
        // caller did not hear the answer, not that it wants the work twice.
        return existing.taskId
          ? { outcome: 'duplicate', entry: { ...existing } }
          : { outcome: 'reserved', entry: { ...existing } };
      }
      if (
        submission.contextId !== undefined &&
        !file.contexts.some(
          (context) =>
            context.sessionId === submission.contextId &&
            context.agentId === submission.targetAgentId,
        )
      ) {
        throw new ExternalIntakeUnknownContextError();
      }
      const entry: ExternalTaskEntry = {
        key,
        contentHash,
        agentId: submission.targetAgentId,
        messageId: submission.messageId,
        createdAt: Date.now(),
        ...(submission.contextId ? { sessionId: submission.contextId } : {}),
      };
      file.tasks.push(entry);
      return { outcome: 'reserved', entry: { ...entry } };
    },
  );
}

/**
 * Step 2 (new context only): records the chat session created for a
 * reservation. Recorded before the message is posted, so a retry after a
 * crash continues in that session instead of creating another.
 */
export async function attachExternalSession(
  projectRoot: string,
  callerId: string,
  key: string,
  sessionId: string,
): Promise<void> {
  await updateExternalCallerFile(projectRoot, callerId, (file) => {
    const entry = file.tasks.find((candidate) => candidate.key === key);
    if (!entry) throw new Error('External reservation disappeared.');
    entry.sessionId = sessionId;
    if (!file.contexts.some((context) => context.sessionId === sessionId)) {
      file.contexts.push({
        sessionId,
        agentId: entry.agentId,
        createdAt: Date.now(),
      });
    }
  });
}

/**
 * Undos {@link attachExternalSession}, after the post into the recorded
 * session was refused for good and the session is being discarded. A retry
 * then re-creates session and context instead of resuming a deleted one.
 *
 * The session's context is dropped only when no other entry continues
 * through it: a second submission naming the same session keeps its
 * authorization.
 */
export async function releaseExternalReservation(
  projectRoot: string,
  callerId: string,
  key: string,
): Promise<void> {
  await updateExternalCallerFile(projectRoot, callerId, (file) => {
    const entry = file.tasks.find((candidate) => candidate.key === key);
    if (!entry?.sessionId) return;
    const sessionId = entry.sessionId;
    delete entry.sessionId;
    if (!file.tasks.some((candidate) => candidate.sessionId === sessionId)) {
      file.contexts = file.contexts.filter(
        (context) => context.sessionId !== sessionId,
      );
    }
  });
}

/** Step 3: records the run the post started. Returns the updated entry. */
export async function completeExternalSubmission(
  projectRoot: string,
  callerId: string,
  key: string,
  taskId: string,
): Promise<ExternalTaskEntry> {
  return updateExternalCallerFile(projectRoot, callerId, (file) => {
    const entry = file.tasks.find((candidate) => candidate.key === key);
    if (!entry) throw new Error('External reservation disappeared.');
    entry.taskId = taskId;
    return { ...entry };
  });
}

/**
 * Keeps the first terminal view of a task, on every entry that names it.
 * Never overwrites one already kept unless `replace`: the owner retried a
 * failed run and the retry has ended.
 */
export async function recordExternalTaskResult(
  projectRoot: string,
  callerId: string,
  taskId: string,
  result: ExternalTaskResult,
  options: { replace?: boolean } = {},
): Promise<ExternalTaskResult> {
  return updateExternalCallerFile(projectRoot, callerId, (file) => {
    const entries = file.tasks.filter((entry) => entry.taskId === taskId);
    const kept =
      (options.replace
        ? undefined
        : entries.find((entry) => entry.result)?.result) ?? result;
    for (const entry of entries) entry.result = kept;
    return kept;
  });
}

/**
 * One task, if it is this caller's.
 *
 * Returns `undefined` for "no such task" and for "not yours" alike. The
 * transport must not distinguish them either: a caller able to tell a task
 * exists but belongs to someone else can enumerate another client's work.
 */
export async function getExternalTaskForCaller(
  projectRoot: string,
  callerId: string,
  taskId: string,
): Promise<ExternalTaskEntry | undefined> {
  if (!isValidId(callerId) || !taskId) return undefined;
  const file = await readExternalCallerFile(projectRoot, callerId);
  return file.tasks.find((entry) => entry.taskId === taskId);
}

/**
 * This caller's accepted tasks for one agent, oldest first, one entry per
 * task (coalesced messages share a task).
 */
export async function listExternalTasksForCaller(
  projectRoot: string,
  callerId: string,
  agentId: string,
): Promise<ExternalTaskEntry[]> {
  if (!isValidId(callerId)) return [];
  const file = await readExternalCallerFile(projectRoot, callerId);
  const seen = new Set<string>();
  const tasks: ExternalTaskEntry[] = [];
  for (const entry of file.tasks) {
    if (entry.agentId !== agentId || !entry.taskId) continue;
    if (seen.has(entry.taskId)) continue;
    seen.add(entry.taskId);
    tasks.push(entry);
  }
  return tasks;
}
