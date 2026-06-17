/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';

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
  /**
   * The repo top-level (output of `GitWorktreeService.getRepoTopLevel()`)
   * captured when the worktree was created — NOT the user's launch cwd.
   *
   * Named `originalCwd` for on-disk back-compat with sidecars written
   * by earlier Phase C builds; semantically this is the value to pass
   * back to `new GitWorktreeService(...)` for any subsequent cleanup
   * (e.g. `handleWorktreeExit`'s remove path), because the worktree
   * always lives under `<repoTopLevel>/.qwen/worktrees/`. When the
   * CLI is launched from a monorepo subdirectory, `process.cwd()` and
   * `getRepoTopLevel()` differ — this field stores the latter.
   *
   * Consumers expecting `process.cwd()` semantics should NOT use this
   * field; capture cwd separately at the time of need.
   */
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

/**
 * Runtime shape check for a parsed sidecar object. Returns true only when
 * every required string field is present and is a string. We treat any
 * missing or wrong-typed field as a corrupted sidecar (could happen if
 * the file was partially written before a crash, truncated by `ENOSPC`,
 * or manually edited).
 */
function isValidWorktreeSession(value: unknown): value is WorktreeSession {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['slug'] === 'string' &&
    typeof v['worktreePath'] === 'string' &&
    typeof v['worktreeBranch'] === 'string' &&
    typeof v['originalCwd'] === 'string' &&
    typeof v['originalBranch'] === 'string' &&
    typeof v['originalHeadCommit'] === 'string'
  );
}

/**
 * Read the sidecar. Returns null when:
 * - file does not exist (ENOENT)
 * - file content is invalid JSON
 * - parsed object does not match {@link WorktreeSession} shape
 *
 * The validation check guards against partial writes and manual edits
 * that would otherwise propagate `undefined` paths into consumers
 * (`removeUserWorktree(undefined)`, `git status` with `cwd: undefined`,
 * Footer rendering `⎇ undefined (undefined)`).
 *
 * Throws only on unexpected I/O errors (permission, EIO, etc.) so the
 * caller can log them; benign ENOENT / parse failures are silenced into
 * a null return.
 */
export async function readWorktreeSession(
  filePath: string,
): Promise<WorktreeSession | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidWorktreeSession(parsed)) return null;
  return parsed;
}

/** Writes the worktree session sidecar via `atomicWriteJSON`. */
export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // atomicWriteJSON pretty-prints with 2-space indent by default.
  await atomicWriteJSON(filePath, session);
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
 * Three "stale" cases produce sidecar cleanup so future `--resume` calls
 * don't keep tripping on the same broken state:
 * 1. ENOENT-followed-by-malformed-JSON (handled inside readWorktreeSession,
 *    which returns null without throwing for parse errors).
 * 2. The worktree directory referenced by a valid sidecar no longer exists.
 * 3. The sidecar exists but `readWorktreeSession` threw a non-ENOENT I/O
 *    error (e.g. permission, EIO) — we still attempt cleanup so the next
 *    resume isn't stuck reading the same broken file.
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
    // Sidecar exists but we can't read it (permission, EIO, …). Try to
    // clear it so subsequent --resume calls don't keep hitting the same
    // error. If the clear also fails, surface that too but don't throw.
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (clearErr) {
      onWarn?.(clearErr);
    }
    return { contextMessage: null, session: null };
  }
  if (!session) {
    // readWorktreeSession returned null. This is either ENOENT (no
    // sidecar, common) or a malformed-JSON / shape-mismatch case. The
    // latter is also worth cleaning up so the same file doesn't bounce
    // off every resume forever. Best-effort: skip cleanup if the file
    // genuinely doesn't exist (clearWorktreeSession is already a
    // ENOENT-tolerant no-op so this is safe to call unconditionally).
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (clearErr) {
      onWarn?.(clearErr);
    }
    return { contextMessage: null, session: null };
  }

  // Structural sanity check: the worktreePath MUST live under
  // `<originalCwd>/.qwen/worktrees/`. Schema validation (readWorktreeSession)
  // already ensures the fields are strings, but a manually-edited or
  // copy-pasted sidecar could still point worktreePath at an arbitrary
  // existing directory — the model would then be directed to operate
  // there. Restrict to the Qwen-managed worktrees subtree so a
  // tampered sidecar can't redirect file operations to /etc, ~/, etc.
  // (PR #4174 review #3256839787.)
  const expectedParent = path.join(session.originalCwd, '.qwen', 'worktrees');
  const resolvedWorktree = path.resolve(session.worktreePath);
  if (
    !resolvedWorktree.startsWith(expectedParent + path.sep) &&
    resolvedWorktree !== expectedParent
  ) {
    onWarn?.(
      new Error(
        `worktreePath ${session.worktreePath} is outside ${expectedParent}; ` +
          `treating sidecar as tampered and clearing.`,
      ),
    );
    try {
      await clearWorktreeSession(sidecarPath);
    } catch (error) {
      onWarn?.(error);
    }
    return { contextMessage: null, session: null };
  }

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
