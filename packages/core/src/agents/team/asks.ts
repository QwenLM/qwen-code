/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { isNodeError } from '../../utils/errors.js';
import {
  assertItemId,
  assertSafeName,
  createBoardRecord,
  getCollectionDir,
  pruneCollection,
  withItemLock,
} from './board-lock.js';

const debug = createDebugLogger('BOARD_ASKS');

export const ASKS_COLLECTION = 'asks';
export const DEFAULT_ASK_TTL_MS = 15 * 60 * 1000;
const MAX_TEXT_LENGTH = 65536;
const ASK_FILE =
  /^a-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export type AskState = 'open' | 'answered' | 'declined' | 'timeout';

export interface AskRecord {
  schemaVersion: 1;
  id: string;
  from: string;
  to: string;
  question: string;
  aboutTask?: string;
  state: AskState;
  createdAt: number;
  expiresAt: number;
  answer: string | null;
  reason: string | null;
  settledAt: number | null;
}

function asksDir(board: string): string {
  return getCollectionDir(board, ASKS_COLLECTION);
}

function askPath(board: string, id: string): string {
  return path.join(asksDir(board), `${id}.json`);
}

function assertText(field: string, value: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_TEXT_LENGTH} characters.`);
  }
}

function parseAsk(value: unknown): AskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ask record must be an object.');
  }
  const ask = value as Partial<AskRecord>;
  if (ask.schemaVersion !== 1) throw new Error('Unsupported ask schema.');
  if (typeof ask.id !== 'string') throw new Error('Ask id must be text.');
  assertItemId('ask id', ask.id, 'a');
  if (typeof ask.from !== 'string' || typeof ask.to !== 'string') {
    throw new Error('Ask actors must be names.');
  }
  assertSafeName('actor name', ask.from);
  assertSafeName('actor name', ask.to);
  if (typeof ask.question !== 'string') {
    throw new Error('Ask question must be text.');
  }
  assertText('question', ask.question);
  if (ask.aboutTask !== undefined) {
    if (typeof ask.aboutTask !== 'string') {
      throw new Error('Ask aboutTask must be a task id.');
    }
    assertItemId('task id', ask.aboutTask, 't');
  }
  if (
    !['open', 'answered', 'declined', 'timeout'].includes(ask.state ?? '')
  ) {
    throw new Error('Invalid ask state.');
  }
  if (!Number.isFinite(ask.createdAt) || !Number.isFinite(ask.expiresAt)) {
    throw new Error('Ask timestamps must be finite numbers.');
  }
  if ((ask.expiresAt ?? 0) <= (ask.createdAt ?? 0)) {
    throw new Error('Ask expiresAt must follow createdAt.');
  }
  if (ask.answer !== null && typeof ask.answer !== 'string') {
    throw new Error('Ask answer must be text or null.');
  }
  if (ask.reason !== null && typeof ask.reason !== 'string') {
    throw new Error('Ask reason must be text or null.');
  }
  if (ask.settledAt !== null && !Number.isFinite(ask.settledAt)) {
    throw new Error('Ask settledAt must be a finite number or null.');
  }
  if (ask.settledAt !== null && (ask.settledAt ?? 0) < (ask.createdAt ?? 0)) {
    throw new Error('Ask settledAt precedes createdAt.');
  }
  if (ask.answer) assertText('answer', ask.answer);
  if (ask.reason) assertText('reason', ask.reason);
  if (ask.state === 'open') {
    if (ask.answer !== null || ask.reason !== null || ask.settledAt !== null) {
      throw new Error('An open ask cannot contain a result.');
    }
  } else if (ask.state === 'answered') {
    if (!ask.answer || ask.reason !== null || ask.settledAt === null) {
      throw new Error('An answered ask requires answer and settledAt.');
    }
  } else if (ask.state === 'timeout') {
    // settleAsk produces this shape in memory; a foreign runtime sharing the
    // board may also write it. It carries no result payload.
    if (ask.settledAt === null || ask.answer !== null || ask.reason !== null) {
      throw new Error('A timed-out ask requires settledAt and no result.');
    }
  } else if (!ask.reason || ask.answer !== null || ask.settledAt === null) {
    throw new Error('A declined ask requires reason and settledAt.');
  }
  return ask as AskRecord;
}

function settleAsk(ask: AskRecord, now = Date.now()): AskRecord {
  if (ask.state !== 'open' || now < ask.expiresAt) return ask;
  return { ...ask, state: 'timeout', settledAt: ask.expiresAt };
}

export async function createAsk(opts: {
  board: string;
  from: string;
  to: string;
  question: string;
  aboutTask?: string;
  ttlMs?: number;
}): Promise<AskRecord> {
  assertSafeName('actor name', opts.from);
  assertSafeName('actor name', opts.to);
  if (opts.from === opts.to)
    throw new Error('An ask must target another actor.');
  assertText('question', opts.question);
  if (opts.aboutTask) assertItemId('task id', opts.aboutTask, 't');
  const ttl = opts.ttlMs ?? DEFAULT_ASK_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('ttlMs must be a positive finite number.');
  }
  const now = Date.now();
  if (!Number.isFinite(now + ttl)) throw new Error('ttlMs is too large.');
  return createBoardRecord(opts.board, ASKS_COLLECTION, 'a', (id) => ({
    schemaVersion: 1,
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
  }));
}

export async function getAsk(
  board: string,
  id: string,
): Promise<AskRecord | null> {
  assertSafeName('board name', board);
  assertItemId('ask id', id, 'a');
  let raw: string;
  try {
    raw = await fs.readFile(askPath(board, id), 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const ask = parseAsk(JSON.parse(raw));
    if (ask.id !== id) throw new Error('Ask id does not match its filename.');
    return settleAsk(ask);
  } catch (err) {
    debug.warn(`skipping invalid ask ${id}:`, err);
    return null;
  }
}

export async function listAsks(board: string): Promise<AskRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(asksDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const asks = (
    await Promise.all(
      files
        .filter((file) => ASK_FILE.test(file))
        .map((file) => getAsk(board, file.slice(0, -5))),
    )
  ).filter((ask): ask is AskRecord => ask !== null);
  return asks.sort((a, b) => a.createdAt - b.createdAt);
}

async function settleOnDisk(
  board: string,
  id: string,
  by: string,
  apply: (ask: AskRecord) => AskRecord,
): Promise<AskRecord> {
  assertSafeName('board name', board);
  assertItemId('ask id', id, 'a');
  assertSafeName('actor name', by);
  const target = askPath(board, id);
  return withItemLock(
    target,
    async () => {
      const current = settleAsk(
        parseAsk(JSON.parse(await fs.readFile(target, 'utf8'))),
      );
      if (current.id !== id) {
        throw new Error('Ask id does not match its filename.');
      }
      if (current.to !== by) {
        throw new Error(`Ask "${id}" is addressed to "${current.to}".`);
      }
      if (current.state !== 'open') {
        throw new Error(`Ask "${id}" is already ${current.state}.`);
      }
      const next = parseAsk(apply(current));
      await atomicWriteJSON(target, next, { mode: 0o600, forceMode: true });
      return next;
    },
    () => {
      throw new Error(`Ask "${id}" not found.`);
    },
  );
}

export function answerAsk(
  board: string,
  id: string,
  by: string,
  answer: string,
): Promise<AskRecord> {
  assertText('answer', answer);
  return settleOnDisk(board, id, by, (ask) => ({
    ...ask,
    state: 'answered',
    answer,
    settledAt: Date.now(),
  }));
}

export function declineAsk(
  board: string,
  id: string,
  by: string,
  reason: string,
): Promise<AskRecord> {
  assertText('reason', reason);
  return settleOnDisk(board, id, by, (ask) => ({
    ...ask,
    state: 'declined',
    reason,
    settledAt: Date.now(),
  }));
}

export function pruneAsks(
  board: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  return pruneCollection(
    board,
    ASKS_COLLECTION,
    ASK_FILE,
    (value) => {
      const ask = parseAsk(value);
      if (ask.state === 'open') {
        return ask.expiresAt <= now ? ask.expiresAt : null;
      }
      return ask.settledAt;
    },
    olderThanMs,
    now,
  );
}
