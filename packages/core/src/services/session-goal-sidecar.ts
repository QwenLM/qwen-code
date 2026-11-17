/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import type { GoalRecord, GoalStatus } from '../goals/goal-protocol.js';

/**
 * List-facing projection of a session's Goal, stored as a sidecar JSON file
 * alongside the transcript at `<chatsDir>/<sessionId>.goal.json`. The
 * transcript's `goal_state` records stay canonical (recovery reads them);
 * this projection exists so the session catalog can show a goal marker
 * without IPC probes or transcript parses — including for unloaded and
 * archived sessions, which the live-only `GET /goals` listing cannot see.
 *
 * Written by the session child on every goal transition (the journal hook
 * in ChatRecordingService.recordGoalState) and once on restore. A stale or
 * missing sidecar only delays the marker until the next transition/load —
 * the same consistency contract the PR-binding sidecar ships with.
 */
export interface SessionGoalSidecar {
  v: 1;
  goalId: string;
  status: GoalStatus;
  objective: string;
  /** Epoch milliseconds, as journaled on the Goal record. */
  updatedAt: number;
}

const GOAL_STATUSES: readonly GoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'complete',
];

/** Runtime shape check: guards partial writes and manual edits. */
export function isValidSessionGoalSidecar(
  value: unknown,
): value is SessionGoalSidecar {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['v'] === 1 &&
    typeof v['goalId'] === 'string' &&
    v['goalId'].length > 0 &&
    typeof v['status'] === 'string' &&
    (GOAL_STATUSES as readonly string[]).includes(v['status']) &&
    typeof v['objective'] === 'string' &&
    typeof v['updatedAt'] === 'number' &&
    Number.isFinite(v['updatedAt']) &&
    // Keep updatedAt within the range Date can represent: the catalog
    // projection renders it via new Date(updatedAt).toISOString(), which
    // throws a RangeError outside ±8.64e15 ms.
    Math.abs(v['updatedAt']) <= 8.64e15
  );
}

/** The projection both writers (journal hook, restore) share. */
export function projectGoalSidecar(goal: GoalRecord): SessionGoalSidecar {
  return {
    v: 1,
    goalId: goal.goalId,
    status: goal.status,
    objective: goal.objective,
    updatedAt: goal.updatedAt,
  };
}

/**
 * Read the sidecar. Returns null when the file is absent, invalid JSON, or
 * fails the shape check — all "no marker" for the list. Throws only on
 * unexpected I/O errors.
 */
export async function readSessionGoalSidecar(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionGoalSidecar | null> {
  let raw: string;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal
      ? await fs.readFile(filePath, {
          encoding: 'utf-8',
          signal: options.signal,
        })
      : await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  options.signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidSessionGoalSidecar(parsed) ? parsed : null;
}

// Serializes mutations per sidecar path WITHIN this process: rapid goal
// transitions (the runtime settles bounds automatically) must land in
// order — two blind overwrites racing could rename the older projection
// last and strand a stale marker until the next transition. Only the
// session child writes a given session's sidecar, so an in-process queue
// suffices; no cross-process lock like the PR list sidecar's is needed.
// A failed predecessor must not block later mutations.
const mutationQueue = new Map<string, Promise<unknown>>();

function enqueueGoalMutation<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueue.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  mutationQueue.set(filePath, next);
  const cleanup = (): void => {
    if (mutationQueue.get(filePath) === next) mutationQueue.delete(filePath);
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * Write the projection atomically. A single-object blind overwrite (no
 * read-modify-write), so temp+rename alone keeps it whole; the queue keeps
 * concurrent transitions ordered.
 */
export async function writeSessionGoalSidecar(
  filePath: string,
  projection: SessionGoalSidecar,
): Promise<void> {
  await enqueueGoalMutation(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteJSON(filePath, projection);
  });
}

/** Remove the projection (goal cleared). Absent is success. */
export async function deleteSessionGoalSidecar(
  filePath: string,
): Promise<void> {
  await enqueueGoalMutation(filePath, async () => {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  });
}

/**
 * Carry the projection across an archive-state move. Absent source is
 * success (most sessions never had a goal); a write racing the move may
 * strand a projection in the old directory — the next transition or
 * restore repairs it, per the lag contract.
 */
export async function moveSessionGoalSidecar(
  fromPath: string,
  toPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  try {
    await fs.rename(fromPath, toPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}
