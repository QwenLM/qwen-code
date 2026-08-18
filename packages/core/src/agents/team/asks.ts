/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ask` board items — a question addressed to a participant, expecting an
 * answer.
 *
 * Stored at `~/.qwen/boards/{board}/asks/{id}.json`.
 *
 * The point of an ask, versus a plain message, is that it has terminal states:
 * `answered`, `declined`, and `timeout`. A sender always learns which, and can
 * then wait, route elsewhere, or escalate. A message that merely "was sent"
 * cannot distinguish a peer that is thinking from one that will never reply.
 *
 * Nothing is delivered. A participant sees an ask when it next reads the
 * board, which is what lets an agent we did not write take part on equal
 * terms: fetching is the one verb available to every participant.
 *
 * Timeout is settled lazily. `expiresAt` is written at creation, and any
 * reader that sees an `open` ask past its deadline reports `timeout` — no
 * sweeper process walks the directory, because a fetch-based system has no
 * daemon guaranteed to be running. The file is rewritten when someone next
 * touches it; until then every reader computes the same answer.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  assertSafeName,
  getCollectionDir,
  withItemLock,
} from './board-lock.js';

const debug = createDebugLogger('BOARD_ASKS');

export const ASKS_COLLECTION = 'asks';

/** Default window before an unanswered ask reports `timeout`. */
export const DEFAULT_ASK_TTL_MS = 15 * 60 * 1000;

/** Cap on question and answer text, mirroring the mailbox message cap. */
const MAX_TEXT_LENGTH = 65536;

export type AskState = 'open' | 'answered' | 'declined' | 'timeout';

export interface AskRecord {
  schemaVersion: number;
  /** Short and typeable — a person enters this in a command. */
  id: string;
  from: string;
  to: string;
  question: string;
  /** Optional link to the work this question is about. */
  aboutTask?: string;
  state: AskState;
  createdAt: number;
  /** Epoch ms after which an `open` ask reads as `timeout`. */
  expiresAt: number;
  answer: string | null;
  reason: string | null;
  settledAt: number | null;
}

const SCHEMA_VERSION = 1;

function asksDir(board: string): string {
  return getCollectionDir(board, ASKS_COLLECTION);
}

function askPath(board: string, id: string): string {
  return path.join(asksDir(board), `${id}.json`);
}

function assertText(field: string, value: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(
      `${field} exceeds ${MAX_TEXT_LENGTH} characters. Trim it, or put the ` +
        `bulk on the task it is about.`,
    );
  }
}

/**
 * Allocate the next `a-N`. Directory listing rather than a counter file: the
 * ids are the directory contents, so there is no second source of truth to
 * fall out of step after a prune.
 */
async function nextAskId(board: string): Promise<string> {
  const dir = asksDir(board);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return 'a-1';
    throw err;
  }
  let max = 0;
  for (const file of files) {
    const m = /^a-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `a-${max + 1}`;
}

/**
 * Apply the lazy timeout rule. Returns the record a reader should see, which
 * may differ from what is on disk for an `open` ask past its deadline.
 */
export function settleAsk(ask: AskRecord, now = Date.now()): AskRecord {
  if (ask.state !== 'open' || now < ask.expiresAt) return ask;
  return { ...ask, state: 'timeout', settledAt: ask.expiresAt };
}

export interface CreateAskOptions {
  board: string;
  from: string;
  to: string;
  question: string;
  aboutTask?: string;
  ttlMs?: number;
}

export async function createAsk(opts: CreateAskOptions): Promise<AskRecord> {
  assertSafeName('board name', opts.board);
  assertSafeName('participant name', opts.from);
  assertSafeName('participant name', opts.to);
  assertText('question', opts.question);

  const dir = asksDir(opts.board);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_ASK_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('ttlMs must be a positive number of milliseconds.');
  }

  // Retry on collision: two processes can compute the same next id before
  // either writes. `wx` fails rather than clobbering, so the loser re-reads.
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = await nextAskId(opts.board);
    const target = askPath(opts.board, id);
    const record: AskRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      from: opts.from,
      to: opts.to,
      question: opts.question,
      ...(opts.aboutTask ? { aboutTask: opts.aboutTask } : {}),
      state: 'open',
      createdAt: now,
      expiresAt: now + ttl,
      answer: null,
      reason: null,
      settledAt: null,
    };
    try {
      // Exclusive create claims the id; the content is written in the same
      // call, so no reader can observe a partial record under this name.
      await fs.writeFile(target, JSON.stringify(record, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      return record;
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate an ask id after 10 attempts.');
}

export async function getAsk(
  board: string,
  id: string,
): Promise<AskRecord | null> {
  assertSafeName('board name', board);
  assertSafeName('ask id', id);
  try {
    const raw = await fs.readFile(askPath(board, id), 'utf8');
    if (!raw.trim()) return null;
    return settleAsk(JSON.parse(raw) as AskRecord);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    debug.warn(`unreadable ask ${id}:`, err);
    return null;
  }
}

export interface ListAsksFilter {
  /** Only asks addressed to this participant. */
  to?: string;
  /** Only asks raised by this participant. */
  from?: string;
  /** Only these states, after the lazy timeout rule is applied. */
  states?: readonly AskState[];
}

export async function listAsks(
  board: string,
  filter: ListAsksFilter = {},
): Promise<AskRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(asksDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const out: AskRecord[] = [];
  for (const file of files) {
    // Strict match: a lenient prefix parse would let an unrelated file be
    // read as an item.
    if (!/^a-\d+\.json$/.test(file)) continue;
    const ask = await getAsk(board, file.slice(0, -'.json'.length));
    if (!ask) continue;
    if (filter.to && ask.to !== filter.to) continue;
    if (filter.from && ask.from !== filter.from) continue;
    if (filter.states && !filter.states.includes(ask.state)) continue;
    out.push(ask);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export class AskSettledError extends Error {
  constructor(id: string, state: AskState) {
    super(`Ask "${id}" is already ${state}.`);
    this.name = 'AskSettledError';
  }
}

async function settleOnDisk(
  board: string,
  id: string,
  apply: (ask: AskRecord) => AskRecord,
): Promise<AskRecord> {
  assertSafeName('board name', board);
  assertSafeName('ask id', id);
  const target = askPath(board, id);
  const missing = () => {
    throw new Error(`Ask "${id}" not found.`);
  };
  return withItemLock(
    target,
    async () => {
      const raw = await fs.readFile(target, 'utf8');
      const onDisk = JSON.parse(raw) as AskRecord;
      // Re-check under the lock: the deadline may have passed while waiting,
      // and answering a timed-out ask would silently resurrect it.
      const current = settleAsk(onDisk);
      if (current.state !== 'open') {
        throw new AskSettledError(id, current.state);
      }
      const next = apply(current);
      await atomicWriteJSON(target, next);
      return next;
    },
    missing,
  );
}

export function answerAsk(
  board: string,
  id: string,
  answer: string,
): Promise<AskRecord> {
  assertText('answer', answer);
  return settleOnDisk(board, id, (ask) => ({
    ...ask,
    state: 'answered',
    answer,
    settledAt: Date.now(),
  }));
}

export function declineAsk(
  board: string,
  id: string,
  reason: string,
): Promise<AskRecord> {
  assertText('reason', reason);
  return settleOnDisk(board, id, (ask) => ({
    ...ask,
    state: 'declined',
    reason,
    settledAt: Date.now(),
  }));
}
