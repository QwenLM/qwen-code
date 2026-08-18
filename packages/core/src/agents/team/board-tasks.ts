/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `task` board items — a unit of work with an owner and a status.
 *
 * Stored at `~/.qwen/boards/{board}/tasks/{id}.json`, alongside `asks/` and
 * `decisions/`.
 *
 * This is deliberately *not* `agents/team/tasks.ts`. That module is Agent
 * Team's in-session task list, keyed by team name under `~/.qwen/tasks/`, with
 * dependency edges, reciprocal-update rules and an in-process change emitter
 * that the leader's scheduler subscribes to. A peer board needs none of that
 * and cannot use its storage root without inheriting the split-root problem
 * the board layout exists to avoid.
 *
 * The two converge later. Keeping them apart now means the board CLI can ship
 * without rewriting the scheduler that Agent Team depends on.
 *
 * Assignment is a proposal: naming an owner records who is expected to take
 * the work, and nothing delivers it. A participant that never claims leaves the
 * task visibly unclaimed — no offer expires, because nothing was ever sent.
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

const debug = createDebugLogger('BOARD_TASKS');

export const TASKS_COLLECTION = 'tasks';

const MAX_TEXT_LENGTH = 65536;
const SCHEMA_VERSION = 1;

export type BoardTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface BoardTaskRecord {
  schemaVersion: number;
  id: string;
  subject: string;
  /** Named owner. A proposal until someone claims — see the module header. */
  owner: string | null;
  status: BoardTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Free text attached to the work, not to a participant. */
  notes: string[];
}

function tasksDir(board: string): string {
  return getCollectionDir(board, TASKS_COLLECTION);
}

function taskPath(board: string, id: string): string {
  return path.join(tasksDir(board), `${id}.json`);
}

function assertText(field: string, value: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} exceeds ${MAX_TEXT_LENGTH} characters.`);
  }
}

async function nextTaskId(board: string): Promise<string> {
  let files: string[];
  try {
    files = await fs.readdir(tasksDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return 't-1';
    throw err;
  }
  let max = 0;
  for (const file of files) {
    const m = /^t-(\d+)\.json$/.exec(file);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `t-${max + 1}`;
}

export interface CreateBoardTaskOptions {
  board: string;
  subject: string;
  owner?: string;
}

export async function createBoardTask(
  opts: CreateBoardTaskOptions,
): Promise<BoardTaskRecord> {
  assertSafeName('board name', opts.board);
  assertText('subject', opts.subject);
  if (opts.owner) assertSafeName('participant name', opts.owner);

  await fs.mkdir(tasksDir(opts.board), { recursive: true, mode: 0o700 });
  const now = Date.now();

  for (let attempt = 0; attempt < 10; attempt++) {
    const id = await nextTaskId(opts.board);
    const record: BoardTaskRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      subject: opts.subject,
      owner: opts.owner ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      notes: [],
    };
    try {
      await fs.writeFile(
        taskPath(opts.board, id),
        JSON.stringify(record, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      return record;
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a task id after 10 attempts.');
}

export async function getBoardTask(
  board: string,
  id: string,
): Promise<BoardTaskRecord | null> {
  assertSafeName('board name', board);
  assertSafeName('task id', id);
  try {
    const raw = await fs.readFile(taskPath(board, id), 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as BoardTaskRecord;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    debug.warn(`unreadable task ${id}:`, err);
    return null;
  }
}

export interface ListBoardTasksFilter {
  owner?: string;
  statuses?: readonly BoardTaskStatus[];
}

export async function listBoardTasks(
  board: string,
  filter: ListBoardTasksFilter = {},
): Promise<BoardTaskRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(tasksDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const out: BoardTaskRecord[] = [];
  for (const file of files) {
    if (!/^t-\d+\.json$/.test(file)) continue;
    const task = await getBoardTask(board, file.slice(0, -'.json'.length));
    if (!task) continue;
    if (filter.owner && task.owner !== filter.owner) continue;
    if (filter.statuses && !filter.statuses.includes(task.status)) continue;
    out.push(task);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

async function mutate(
  board: string,
  id: string,
  apply: (task: BoardTaskRecord) => BoardTaskRecord,
): Promise<BoardTaskRecord> {
  assertSafeName('board name', board);
  assertSafeName('task id', id);
  const target = taskPath(board, id);
  return withItemLock(
    target,
    async () => {
      const raw = await fs.readFile(target, 'utf8');
      const current = JSON.parse(raw) as BoardTaskRecord;
      const next = { ...apply(current), updatedAt: Date.now() };
      await atomicWriteJSON(target, next);
      return next;
    },
    () => {
      throw new Error(`Task "${id}" not found.`);
    },
  );
}

export class TaskClaimedError extends Error {
  constructor(id: string, owner: string) {
    super(`Task "${id}" is already claimed by "${owner}".`);
    this.name = 'TaskClaimedError';
  }
}

/**
 * Take ownership. Claiming is the act that binds; a named owner alone does
 * not. Re-claiming your own task is a no-op rather than an error so a retrying
 * participant does not have to special-case it.
 */
export function claimBoardTask(
  board: string,
  id: string,
  by: string,
): Promise<BoardTaskRecord> {
  assertSafeName('participant name', by);
  return mutate(board, id, (task) => {
    if (task.owner && task.owner !== by && task.status === 'in_progress') {
      throw new TaskClaimedError(id, task.owner);
    }
    return { ...task, owner: by, status: 'in_progress' };
  });
}

export function updateBoardTask(
  board: string,
  id: string,
  patch: { status?: BoardTaskStatus; note?: string; owner?: string | null },
): Promise<BoardTaskRecord> {
  if (patch.note !== undefined) assertText('note', patch.note);
  if (patch.owner) assertSafeName('participant name', patch.owner);
  return mutate(board, id, (task) => ({
    ...task,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
    ...(patch.note ? { notes: [...task.notes, patch.note] } : {}),
  }));
}

/** Release ownership without completing — the task returns to the pool. */
export function releaseBoardTask(
  board: string,
  id: string,
): Promise<BoardTaskRecord> {
  return mutate(board, id, (task) => ({
    ...task,
    owner: null,
    status: 'pending',
  }));
}
