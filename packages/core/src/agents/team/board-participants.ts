/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Who is on a board.
 *
 * Stored at `~/.qwen/boards/{board}/participants/{name}.json`.
 *
 * Without this the only participants visible are those who have already owned
 * a task or been party to an ask — so an agent that joined a minute ago cannot
 * be addressed, because nothing knows its name. `board ask <name>` needs a name
 * to guess otherwise.
 *
 * This does not duplicate the machine-wide session registry
 * (`~/.qwen/sessions/<pid>.json`). That one is keyed by pid and answers "what
 * is alive"; this one is keyed by declared name and answers "who is on this
 * board". Liveness is read from the former, so a participant record never has
 * to be heartbeated — a crashed agent stops being listed because its pid is
 * gone, not because it failed to check in.
 *
 * Names are claims, not authentication. The trust boundary is the uid that
 * owns the directory (mode 0700), exactly as for every other item.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { isNodeError } from '../../utils/errors.js';
import { isPidAlive } from '../../utils/process-liveness.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  assertSafeName,
  getCollectionDir,
  withItemLock,
} from './board-lock.js';

const debug = createDebugLogger('BOARD_PARTICIPANTS');

export const PARTICIPANTS_COLLECTION = 'participants';
const SCHEMA_VERSION = 1;

/**
 * `spawned` is an agent a leader started; `interactive` a session someone is
 * sitting at; `daemon` a background one; `foreign` a tool that is not Qwen
 * Code. The distinction matters because a spawned agent exists to do what it
 * is given, while an independent one has its own work — so an assignment binds
 * for the first and is a proposal for the second.
 */
export type ParticipantKind = 'interactive' | 'daemon' | 'spawned' | 'foreign';

export interface ParticipantRecord {
  schemaVersion: number;
  name: string;
  pid: number;
  sessionId?: string;
  cwd: string;
  kind: ParticipantKind;
  joinedAt: number;
}

function participantsDir(board: string): string {
  return getCollectionDir(board, PARTICIPANTS_COLLECTION);
}

function participantPath(board: string, name: string): string {
  return path.join(participantsDir(board), `${name}.json`);
}

async function readRecord(
  board: string,
  name: string,
): Promise<ParticipantRecord | null> {
  try {
    const raw = await fs.readFile(participantPath(board, name), 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as ParticipantRecord;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    debug.warn(`unreadable participant ${name}:`, err);
    return null;
  }
}

export interface JoinBoardOptions {
  board: string;
  name: string;
  kind?: ParticipantKind;
  cwd?: string;
  sessionId?: string;
  pid?: number;
}

/**
 * Claim a name on a board. Returns the record actually written — the name may
 * differ from the one asked for.
 *
 * A name held by a live process is taken, and the claim gets a numeric suffix
 * rather than failing: a caller that has to handle "try again with a different
 * name" will either pick badly or give up. A name whose holder is gone is
 * reclaimed, otherwise a crash loop would exhaust every reasonable name.
 */
export async function joinBoard(
  opts: JoinBoardOptions,
): Promise<ParticipantRecord> {
  assertSafeName('board name', opts.board);
  assertSafeName('participant name', opts.name);
  await fs.mkdir(participantsDir(opts.board), {
    recursive: true,
    mode: 0o700,
  });

  const pid = opts.pid ?? process.pid;
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = attempt === 0 ? opts.name : `${opts.name}-${attempt + 1}`;
    const existing = await readRecord(opts.board, name);
    if (existing && existing.pid !== pid && isPidAlive(existing.pid)) {
      continue;
    }
    const record: ParticipantRecord = {
      schemaVersion: SCHEMA_VERSION,
      name,
      pid,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      cwd: opts.cwd ?? process.cwd(),
      kind: opts.kind ?? 'interactive',
      joinedAt: Date.now(),
    };
    await atomicWriteJSON(participantPath(opts.board, name), record);
    return record;
  }
  throw new Error(
    `Could not claim a name near "${opts.name}" — 50 variants are held by ` +
      `live processes.`,
  );
}

export async function leaveBoard(
  board: string,
  name: string,
): Promise<boolean> {
  assertSafeName('board name', board);
  assertSafeName('participant name', name);
  const target = participantPath(board, name);
  return withItemLock(
    target,
    async () => {
      await fs.unlink(target);
      return true;
    },
    () => false,
  );
}

export interface ListParticipantsOptions {
  /** Include records whose process is gone. Default false. */
  includeStale?: boolean;
}

/**
 * Who is on the board. Stale records — the holder's process is gone — are
 * filtered out by default rather than deleted: a reader should not have to take
 * a write lock, and the next `joinBoard` reclaims the name anyway.
 */
export async function listParticipants(
  board: string,
  opts: ListParticipantsOptions = {},
): Promise<ParticipantRecord[]> {
  assertSafeName('board name', board);
  let files: string[];
  try {
    files = await fs.readdir(participantsDir(board));
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  const out: ParticipantRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readRecord(board, file.slice(0, -'.json'.length));
    if (!record) continue;
    if (!opts.includeStale && !isPidAlive(record.pid)) continue;
    out.push(record);
  }
  out.sort((a, b) => a.joinedAt - b.joinedAt);
  return out;
}
