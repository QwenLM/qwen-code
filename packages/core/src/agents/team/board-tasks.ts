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

const debug = createDebugLogger('BOARD_TASKS');

export const TASKS_COLLECTION = 'tasks';
const MAX_TEXT_LENGTH = 65536;
const TASK_FILE =
  /^t-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export type BoardTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface BoardTaskRecord {
  schemaVersion: 1;
  id: string;
  subject: string;
  createdBy: string;
  owner: string | null;
  status: BoardTaskStatus;
  createdAt: number;
  updatedAt: number;
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

function parseTask(value: unknown): BoardTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task record must be an object.');
  }
  const task = value as Partial<BoardTaskRecord>;
  if (task.schemaVersion !== 1) throw new Error('Unsupported task schema.');
  if (typeof task.id !== 'string') throw new Error('Task id must be text.');
  assertItemId('task id', task.id, 't');
  if (typeof task.subject !== 'string') {
    throw new Error('Task subject must be text.');
  }
  assertText('subject', task.subject);
  if (typeof task.createdBy !== 'string') {
    throw new Error('Task createdBy must be a name.');
  }
  assertSafeName('actor name', task.createdBy);
  if (task.owner !== null && typeof task.owner !== 'string') {
    throw new Error('Task owner must be a name or null.');
  }
  if (task.owner !== null) assertSafeName('actor name', task.owner);
  if (!['pending', 'in_progress', 'completed'].includes(task.status ?? '')) {
    throw new Error('Invalid task status.');
  }
  if (!Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt)) {
    throw new Error('Task timestamps must be finite numbers.');
  }
  if ((task.updatedAt ?? 0) < (task.createdAt ?? 0)) {
    throw new Error('Task updatedAt precedes createdAt.');
  }
  if (
    !Array.isArray(task.notes) ||
    !task.notes.every((n) => typeof n === 'string')
  ) {
    throw new Error('Task notes must be strings.');
  }
  for (const note of task.notes) assertText('note', note);
  return task as BoardTaskRecord;
}

export async function createBoardTask(opts: {
  board: string;
  createdBy: string;
  subject: string;
  owner?: string;
}): Promise<BoardTaskRecord> {
  assertSafeName('actor name', opts.createdBy);
  assertText('subject', opts.subject);
  if (opts.owner !== undefined) assertSafeName('actor name', opts.owner);
  const now = Date.now();
  return createBoardRecord(opts.board, TASKS_COLLECTION, 't', (id) => ({
    schemaVersion: 1,
    id,
    subject: opts.subject,
    createdBy: opts.createdBy,
    owner: opts.owner ?? null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    notes: [],
  }));
}

async function getBoardTask(
  board: string,
  id: string,
): Promise<BoardTaskRecord | null> {
  assertSafeName('board name', board);
  assertItemId('task id', id, 't');
  let raw: string;
  try {
    raw = await fs.readFile(taskPath(board, id), 'utf8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const task = parseTask(JSON.parse(raw));
    if (task.id !== id) throw new Error('Task id does not match its filename.');
    return task;
  } catch (err) {
    debug.warn(`skipping invalid task ${id}:`, err);
    return null;
  }
}

export async function listBoardTasks(
  board: string,
): Promise<BoardTaskRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(tasksDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
  const tasks = (
    await Promise.all(
      files
        .filter((file) => TASK_FILE.test(file))
        .map((file) => getBoardTask(board, file.slice(0, -5))),
    )
  ).filter((task): task is BoardTaskRecord => task !== null);
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

async function mutate(
  board: string,
  id: string,
  apply: (task: BoardTaskRecord) => BoardTaskRecord,
): Promise<BoardTaskRecord> {
  assertSafeName('board name', board);
  assertItemId('task id', id, 't');
  const target = taskPath(board, id);
  return withItemLock(
    target,
    async () => {
      const current = parseTask(JSON.parse(await fs.readFile(target, 'utf8')));
      if (current.id !== id) {
        throw new Error('Task id does not match its filename.');
      }
      const next = parseTask({ ...apply(current), updatedAt: Date.now() });
      await atomicWriteJSON(target, next, { mode: 0o600, forceMode: true });
      return next;
    },
    () => {
      throw new Error(`Task "${id}" not found.`);
    },
  );
}

export function claimBoardTask(
  board: string,
  id: string,
  by: string,
): Promise<BoardTaskRecord> {
  assertSafeName('actor name', by);
  return mutate(board, id, (task) => {
    if (task.status === 'completed') {
      throw new Error(`Task "${id}" is already completed.`);
    }
    if (task.status === 'in_progress' && task.owner !== by) {
      throw new Error(`Task "${id}" is already claimed by "${task.owner}".`);
    }
    return { ...task, owner: by, status: 'in_progress' };
  });
}

export function completeBoardTask(
  board: string,
  id: string,
  by: string,
  note?: string,
): Promise<BoardTaskRecord> {
  assertSafeName('actor name', by);
  if (note !== undefined) assertText('note', note);
  return mutate(board, id, (task) => {
    if (task.owner !== by || task.status !== 'in_progress') {
      throw new Error(`Task "${id}" is not in progress for "${by}".`);
    }
    return {
      ...task,
      status: 'completed',
      ...(note ? { notes: [...task.notes, note] } : {}),
    };
  });
}

export function pruneBoardTasks(
  board: string,
  olderThanMs: number,
  now?: number,
): Promise<string[]> {
  return pruneCollection(
    board,
    TASKS_COLLECTION,
    TASK_FILE,
    (value) => {
      const task = parseTask(value);
      return task.status === 'completed' ? task.updatedAt : null;
    },
    olderThanMs,
    now,
  );
}
