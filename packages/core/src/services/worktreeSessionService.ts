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

export interface WorktreeRestoreResult {
  /**
   * When non-null, the worktree directory is still alive — callers should
   * surface this one-line context message so the model continues using
   * the worktree path for file operations after a `--resume`.
   *
   * Each entry point chooses its own injection mechanism:
   * - TUI: `historyManager.addItem({ type: INFO, text })`
   * - Headless: prepend as a `<system-reminder>` block to the user prompt
   * - ACP: emit as a `system` message and prepend to the next prompt
   */
  contextMessage: string | null;
  /** Active worktree session, or null when no sidecar / sidecar was stale. */
  session: WorktreeSession | null;
}

/**
 * Reads the WorktreeSession sidecar for the current session, validates
 * that the worktree directory still exists on disk, and either:
 *
 * - returns a context message + the live session, or
 * - deletes the stale sidecar and returns nulls.
 *
 * Shared by TUI / headless / ACP entry points so all three behave
 * consistently on `--resume`. Failures are logged via the supplied
 * `onWarn` callback but never thrown — worktree restore is best-effort,
 * the session itself must still load.
 */
export async function restoreWorktreeContext(
  sidecarPath: string,
  onWarn?: (error: unknown) => void,
): Promise<WorktreeRestoreResult> {
  let session: WorktreeSession | null = null;
  try {
    session = await readWorktreeSession(sidecarPath);
  } catch (error) {
    onWarn?.(error);
    return { contextMessage: null, session: null };
  }
  if (!session) return { contextMessage: null, session: null };

  let worktreeAlive = false;
  try {
    const stat = await fs.stat(session.worktreePath);
    worktreeAlive = stat.isDirectory();
  } catch {
    worktreeAlive = false;
  }

  if (!worktreeAlive) {
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (error) {
      onWarn?.(error);
    }
    return { contextMessage: null, session: null };
  }

  return {
    session,
    contextMessage:
      `[Resumed] Active worktree: "${session.slug}" at ${session.worktreePath} ` +
      `(branch: ${session.worktreeBranch}). Continue using this path for all file operations.`,
  };
}
