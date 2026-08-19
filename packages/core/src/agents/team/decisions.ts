/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `decision` board items — something awaiting human authority.
 *
 * Stored at `~/.qwen/boards/{board}/decisions/{id}.json`.
 *
 * Approving a dangerous operation, accepting a finished result, and
 * adjudicating two conflicting results are the same act: each needs
 * *authority*, and no agent has more of it than another. Unifying them under
 * one item gives the exception view something to show — a `decision` list is
 * the answer to "what is waiting on me".
 *
 * Two rules distinguish this from an `ask`:
 *
 * - **No agent is supposed to resolve one.** This is a convention the prompt
 *   states, not an invariant the runtime enforces: `qwen board resolve` sits on
 *   the same CLI an agent uses for everything else, so anything with a shell
 *   could settle its own decision. Enforcing it would need a surface the agent
 *   panes do not carry; until then the honest description is "by agreement".
 * - **No expiry.** A decision that expires silently converts "nobody has looked
 *   yet" into "the system decided for them", which is the exact authority
 *   nothing but a human may hold. Decisions stall visibly instead — the cost
 *   is intended and is why the exception view exists.
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

const debug = createDebugLogger('BOARD_DECISIONS');

export const DECISIONS_COLLECTION = 'decisions';

const MAX_TEXT_LENGTH = 65536;
const SCHEMA_VERSION = 1;

export type DecisionKind = 'approval' | 'acceptance' | 'adjudication';
export type DecisionState = 'open' | 'approved' | 'rejected';

/** `acceptance` and `adjudication` are always about a task; `approval` may not be. */
const REQUIRES_ABOUT: ReadonlySet<DecisionKind> = new Set([
  'acceptance',
  'adjudication',
]);

export interface DecisionRecord {
  schemaVersion: number;
  id: string;
  kind: DecisionKind;
  raisedBy: string;
  about?: string;
  question: string;
  state: DecisionState;
  createdAt: number;
  resolvedAt: number | null;
  /** The human's reason, when they give one. */
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

async function nextDecisionId(board: string): Promise<string> {
  const dir = decisionsDir(board);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return 'd-1';
    throw err;
  }
  let max = 0;
  for (const file of files) {
    const m = /^d-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `d-${max + 1}`;
}

export interface RaiseDecisionOptions {
  board: string;
  kind: DecisionKind;
  raisedBy: string;
  question: string;
  about?: string;
}

export async function raiseDecision(
  opts: RaiseDecisionOptions,
): Promise<DecisionRecord> {
  assertSafeName('board name', opts.board);
  assertSafeName('participant name', opts.raisedBy);
  assertText('question', opts.question);
  if (REQUIRES_ABOUT.has(opts.kind) && !opts.about) {
    throw new Error(
      `A "${opts.kind}" decision must name the task it is about via "about".`,
    );
  }

  const dir = decisionsDir(opts.board);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 10; attempt++) {
    const id = await nextDecisionId(opts.board);
    const record: DecisionRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      kind: opts.kind,
      raisedBy: opts.raisedBy,
      ...(opts.about ? { about: opts.about } : {}),
      question: opts.question,
      state: 'open',
      createdAt: Date.now(),
      resolvedAt: null,
      note: null,
    };
    try {
      await fs.writeFile(
        decisionPath(opts.board, id),
        JSON.stringify(record, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      return record;
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a decision id after 10 attempts.');
}

export async function getDecision(
  board: string,
  id: string,
): Promise<DecisionRecord | null> {
  assertSafeName('board name', board);
  assertSafeName('decision id', id);
  try {
    const raw = await fs.readFile(decisionPath(board, id), 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as DecisionRecord;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    debug.warn(`unreadable decision ${id}:`, err);
    return null;
  }
}

export interface ListDecisionsFilter {
  states?: readonly DecisionState[];
  kinds?: readonly DecisionKind[];
}

export async function listDecisions(
  board: string,
  filter: ListDecisionsFilter = {},
): Promise<DecisionRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(decisionsDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const out: DecisionRecord[] = [];
  for (const file of files) {
    if (!/^d-\d+\.json$/.test(file)) continue;
    const item = await getDecision(board, file.slice(0, -'.json'.length));
    if (!item) continue;
    if (filter.states && !filter.states.includes(item.state)) continue;
    if (filter.kinds && !filter.kinds.includes(item.kind)) continue;
    out.push(item);
  }
  // Oldest first: the exception view reads top-down, and the thing that has
  // been waiting longest is the thing most likely to be blocking someone.
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export class DecisionSettledError extends Error {
  constructor(id: string, state: DecisionState) {
    super(`Decision "${id}" is already ${state}.`);
    this.name = 'DecisionSettledError';
  }
}

/**
 * Resolve a decision. Intended for the human, and the prompt tells agents not
 * to call it — but nothing here checks, so treat "no agent resolves one" as a
 * convention rather than a guarantee (see the module header).
 */
export async function resolveDecision(
  board: string,
  id: string,
  outcome: 'approved' | 'rejected',
  note?: string,
): Promise<DecisionRecord> {
  assertSafeName('board name', board);
  assertSafeName('decision id', id);
  if (note !== undefined) assertText('note', note);

  const target = decisionPath(board, id);
  const missing = () => {
    throw new Error(`Decision "${id}" not found.`);
  };
  return withItemLock(
    target,
    async () => {
      const raw = await fs.readFile(target, 'utf8');
      const current = JSON.parse(raw) as DecisionRecord;
      if (current.state !== 'open') {
        throw new DecisionSettledError(id, current.state);
      }
      const next: DecisionRecord = {
        ...current,
        state: outcome,
        resolvedAt: Date.now(),
        note: note ?? null,
      };
      await atomicWriteJSON(target, next);
      return next;
    },
    missing,
  );
}
