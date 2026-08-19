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

const debug = createDebugLogger('BOARD_DECISIONS');

export const DECISIONS_COLLECTION = 'decisions';
const MAX_TEXT_LENGTH = 65536;
const DECISION_FILE = /^d-[0-9a-f-]{36}\.json$/;

export type DecisionState = 'open' | 'approved' | 'rejected';

export interface DecisionRecord {
  schemaVersion: 1;
  id: string;
  raisedBy: string;
  about?: string;
  question: string;
  state: DecisionState;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  note: string | null;
}

function decisionsDir(board: string): string {
  return getCollectionDir(board, DECISIONS_COLLECTION);
}

function decisionPath(board: string, id: string): string {
  return path.join(decisionsDir(board), `${id}.json`);
}

function assertText(field: string, value: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_TEXT_LENGTH} characters.`);
  }
}

function parseDecision(value: unknown): DecisionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Decision record must be an object.');
  }
  const decision = value as Partial<DecisionRecord>;
  if (decision.schemaVersion !== 1) {
    throw new Error('Unsupported decision schema.');
  }
  if (typeof decision.id !== 'string') {
    throw new Error('Decision id must be text.');
  }
  assertItemId('decision id', decision.id, 'd');
  if (typeof decision.raisedBy !== 'string') {
    throw new Error('Decision raisedBy must be a name.');
  }
  assertSafeName('actor name', decision.raisedBy);
  if (decision.about !== undefined) {
    if (typeof decision.about !== 'string') {
      throw new Error('Decision about must be an item id.');
    }
    assertItemId('item id', decision.about);
  }
  if (typeof decision.question !== 'string') {
    throw new Error('Decision question must be text.');
  }
  assertText('question', decision.question);
  if (!['open', 'approved', 'rejected'].includes(decision.state ?? '')) {
    throw new Error('Invalid decision state.');
  }
  if (!Number.isFinite(decision.createdAt)) {
    throw new Error('Decision createdAt must be a finite number.');
  }
  if (decision.resolvedAt !== null && !Number.isFinite(decision.resolvedAt)) {
    throw new Error('Decision resolvedAt must be a finite number or null.');
  }
  if (
    decision.resolvedAt !== null &&
    (decision.resolvedAt ?? 0) < (decision.createdAt ?? 0)
  ) {
    throw new Error('Decision resolvedAt precedes createdAt.');
  }
  if (decision.resolvedBy !== null && typeof decision.resolvedBy !== 'string') {
    throw new Error('Decision resolvedBy must be a name or null.');
  }
  if (decision.resolvedBy) {
    assertSafeName('actor name', decision.resolvedBy);
  }
  if (decision.note !== null && typeof decision.note !== 'string') {
    throw new Error('Decision note must be text or null.');
  }
  if (decision.note) assertText('note', decision.note);
  if (decision.state === 'open') {
    if (
      decision.resolvedAt !== null ||
      decision.resolvedBy !== null ||
      decision.note !== null
    ) {
      throw new Error('An open decision cannot contain a resolution.');
    }
  } else if (decision.resolvedAt === null || !decision.resolvedBy) {
    throw new Error('A resolved decision requires resolvedAt and resolvedBy.');
  }
  return decision as DecisionRecord;
}

export async function raiseDecision(opts: {
  board: string;
  raisedBy: string;
  question: string;
  about?: string;
}): Promise<DecisionRecord> {
  assertSafeName('actor name', opts.raisedBy);
  assertText('question', opts.question);
  if (opts.about) assertItemId('item id', opts.about);
  const now = Date.now();
  return createBoardRecord(opts.board, DECISIONS_COLLECTION, 'd', (id) => ({
    schemaVersion: 1,
    id,
    raisedBy: opts.raisedBy,
    ...(opts.about ? { about: opts.about } : {}),
    question: opts.question,
    state: 'open',
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    note: null,
  }));
}

async function getDecision(
  board: string,
  id: string,
): Promise<DecisionRecord | null> {
  assertSafeName('board name', board);
  assertItemId('decision id', id, 'd');
  let raw: string;
  try {
    raw = await fs.readFile(decisionPath(board, id), 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return parseDecision(JSON.parse(raw));
  } catch (err) {
    debug.warn(`skipping invalid decision ${id}:`, err);
    return null;
  }
}

export async function listDecisions(board: string): Promise<DecisionRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(decisionsDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const decisions = (
    await Promise.all(
      files
        .filter((file) => DECISION_FILE.test(file))
        .map((file) => getDecision(board, file.slice(0, -5))),
    )
  ).filter((decision): decision is DecisionRecord => decision !== null);
  return decisions.sort((a, b) => a.createdAt - b.createdAt);
}

export function resolveDecision(
  board: string,
  id: string,
  by: string,
  outcome: 'approved' | 'rejected',
  note?: string,
): Promise<DecisionRecord> {
  assertSafeName('board name', board);
  assertItemId('decision id', id, 'd');
  assertSafeName('actor name', by);
  if (note !== undefined) assertText('note', note);
  const target = decisionPath(board, id);
  return withItemLock(
    target,
    async () => {
      const current = parseDecision(
        JSON.parse(await fs.readFile(target, 'utf8')),
      );
      if (current.state !== 'open') {
        throw new Error(`Decision "${id}" is already ${current.state}.`);
      }
      const next = parseDecision({
        ...current,
        state: outcome,
        resolvedAt: Date.now(),
        resolvedBy: by,
        note: note ?? null,
      });
      await atomicWriteJSON(target, next, { mode: 0o600, forceMode: true });
      return next;
    },
    () => {
      throw new Error(`Decision "${id}" not found.`);
    },
  );
}

export function pruneDecisions(
  board: string,
  olderThanMs: number,
  now?: number,
): Promise<string[]> {
  return pruneCollection(
    board,
    DECISIONS_COLLECTION,
    DECISION_FILE,
    (value) => {
      const decision = parseDecision(value);
      return decision.state === 'open' ? null : decision.resolvedAt;
    },
    olderThanMs,
    now,
  );
}
