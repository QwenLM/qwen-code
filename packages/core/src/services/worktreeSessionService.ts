/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';

/**
 * Persisted state for an active user worktree session. Written when the
 * `EnterWorktreeTool` succeeds, cleared when `ExitWorktreeTool` succeeds,
 * and read on `--resume` so the CLI can restore worktree context.
 *
 * Stored as a sidecar JSON file alongside the session's JSONL transcript at
 * `<chatsDir>/<sessionId>.worktree.json`.
 */
export interface WorktreeSession {
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  originalCwd: string;
  originalBranch: string;
  /**
   * HEAD commit SHA captured at the moment the worktree was created.
   * Used by `WorktreeExitDialog` to count new commits inside the worktree.
   * Empty string when capture failed (rev-parse error) — consumers must
   * treat empty as "unknown" and skip the commit-count display.
   */
  originalHeadCommit: string;
}

export async function readWorktreeSession(
  filePath: string,
): Promise<WorktreeSession | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as WorktreeSession;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function clearWorktreeSession(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}
