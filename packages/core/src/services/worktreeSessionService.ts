/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { isNodeError } from '../utils/errors.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { readRuntimeStatus } from '../utils/runtimeStatus.js';
import { readWorktreeSessionMarker } from './gitWorktreeService.js';

const RUNTIME_STATUS_SCAN_MAX_DIRS = 5000;
const WORKTREE_SESSION_SIDECAR_MAX_BYTES = 64 * 1024;
const RUNTIME_STATUS_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);

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
   * The root used by the worktree service that created this checkout.
   *
   * Named `originalCwd` for on-disk back-compat with sidecars written
   * by earlier Phase C builds. Tool and startup flows store the Git repo
   * top-level here, while legacy daemon-created worktrees may store the
   * registered workspace root. Consumers should use it only to resolve the
   * worktree service, not as proof of daemon workspace ownership.
   *
   * Consumers expecting `process.cwd()` semantics should NOT use this
   * field; capture cwd separately at the time of need.
   */
  originalCwd: string;
  /** Registered daemon workspace root for route-owned worktree attestation. */
  workspaceCwd?: string;
  originalBranch: string;
  /**
   * HEAD commit SHA captured at the moment the worktree was created.
   * Used by `WorktreeExitDialog` to count new commits inside the worktree.
   * Empty string when capture failed (rev-parse error) — consumers must
   * treat empty as "unknown" and skip the commit-count display.
   */
  originalHeadCommit: string;
}

export type StrictWorktreeSession =
  | { state: 'missing' }
  | { state: 'valid'; session: WorktreeSession }
  | { state: 'invalid'; reason: string };

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
    (v['workspaceCwd'] === undefined ||
      typeof v['workspaceCwd'] === 'string') &&
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
  options: { signal?: AbortSignal } = {},
): Promise<WorktreeSession | null> {
  let raw: string;
  let handle: fs.FileHandle | undefined;
  try {
    options.signal?.throwIfAborted();
    const pathStat = await fs.lstat(filePath);
    if (!pathStat.isFile() || pathStat.nlink !== 1) return null;
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size > WORKTREE_SESSION_SIDECAR_MAX_BYTES
    ) {
      return null;
    }
    const buffer = Buffer.alloc(WORKTREE_SESSION_SIDECAR_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > WORKTREE_SESSION_SIDECAR_MAX_BYTES) return null;
    options.signal?.throwIfAborted();
    const finalStat = await fs.lstat(filePath);
    if (
      !finalStat.isFile() ||
      finalStat.nlink !== 1 ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino
    ) {
      return null;
    }
    raw = buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
  options.signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();
  if (!isValidWorktreeSession(parsed)) return null;
  return parsed;
}

/** Strict daemon-only sidecar read that preserves corruption for recovery. */
export async function readWorktreeSessionStrict(
  filePath: string,
): Promise<StrictWorktreeSession> {
  let handle: fs.FileHandle | undefined;
  let observedSidecar = false;
  try {
    const flags =
      nodeFs.constants.O_RDONLY |
      (nodeFs.constants.O_NOFOLLOW ?? 0) |
      (nodeFs.constants.O_NONBLOCK ?? 0);
    const before = await fs.lstat(filePath);
    observedSidecar = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { state: 'invalid', reason: 'unsafe sidecar file type' };
    }
    if (before.ino === 0 || before.size > WORKTREE_SESSION_SIDECAR_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe sidecar size or identity' };
    }
    handle = await fs.open(filePath, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return {
        state: 'invalid',
        reason: 'sidecar identity changed before read',
      };
    }
    const buffer = Buffer.alloc(WORKTREE_SESSION_SIDECAR_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > WORKTREE_SESSION_SIDECAR_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe sidecar size or identity' };
    }
    const after = await handle.stat();
    const pathStats = await fs.lstat(filePath);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== bytesRead ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      pathStats.dev !== after.dev ||
      pathStats.ino !== after.ino
    ) {
      return {
        state: 'invalid',
        reason: 'sidecar identity changed during read',
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch {
      return { state: 'invalid', reason: 'invalid sidecar JSON' };
    }
    if (!isValidWorktreeSession(parsed)) {
      return { state: 'invalid', reason: 'invalid sidecar contents' };
    }
    return { state: 'valid', session: parsed };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return observedSidecar
        ? { state: 'invalid', reason: 'sidecar disappeared during read' }
        : { state: 'missing' };
    }
    return {
      state: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => {});
  }
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

async function fsyncParentDirectory(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(path.dirname(filePath), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      process.platform !== 'win32'
    ) {
      throw error;
    }
  }
}

/** Creates a new sidecar without replacing an existing session binding. */
export async function createWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let openedStat: Awaited<ReturnType<typeof handle.stat>> | undefined;
  let written = false;
  try {
    openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1) {
      throw new Error('Worktree session sidecar must be a regular file');
    }
    await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await handle.sync();
    const pathStat = await fs.lstat(filePath);
    if (
      !pathStat.isFile() ||
      pathStat.nlink !== 1 ||
      pathStat.dev !== openedStat.dev ||
      pathStat.ino !== openedStat.ino
    ) {
      throw new Error('Worktree session sidecar path changed');
    }
    written = true;
  } finally {
    await handle.close();
    if (!written && openedStat) {
      await fs
        .lstat(filePath)
        .then(async (pathStat) => {
          if (
            pathStat.isFile() &&
            pathStat.nlink === 1 &&
            pathStat.dev === openedStat!.dev &&
            pathStat.ino === openedStat!.ino
          ) {
            await fs.unlink(filePath);
          }
        })
        .catch(() => {});
    }
  }
  await fsyncParentDirectory(filePath);
}

export async function clearWorktreeSession(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

export async function clearWorktreeSessionDurable(
  filePath: string,
): Promise<void> {
  await clearWorktreeSession(filePath);
  await fsyncParentDirectory(filePath);
}

export async function isSessionRuntimeActive(
  sessionId: string,
  projectRoots: string | readonly string[],
): Promise<boolean> {
  return (
    (await getSessionRuntimeLiveness(sessionId, projectRoots)) !== 'inactive'
  );
}

export type SessionRuntimeLiveness = 'active' | 'inactive' | 'unknown';

export async function getSessionRuntimeLiveness(
  sessionId: string,
  projectRoots: string | readonly string[],
): Promise<SessionRuntimeLiveness> {
  const roots = uniquePaths(
    (Array.isArray(projectRoots) ? projectRoots : [projectRoots]).map((root) =>
      path.resolve(root),
    ),
  );
  const runtimeBases = getRuntimeBaseCandidates(roots);
  let sawDeadRuntimeStatus = false;
  let sawUnknownRuntimeStatus = false;

  for (const runtimeBase of runtimeBases) {
    for (const projectRoot of roots) {
      const statusPath = await Storage.runWithRuntimeBaseDir(
        runtimeBase,
        undefined,
        async () => new Storage(projectRoot).getRuntimeStatusPath(sessionId),
      );
      const statusState = await getRuntimeStatusPathState(
        statusPath,
        sessionId,
      );
      if (statusState === 'active') {
        return 'active';
      }
      sawDeadRuntimeStatus ||= statusState === 'dead';
      sawUnknownRuntimeStatus ||= statusState === 'unknown';
    }

    const baseState = await getRuntimeStatusStateInBase(runtimeBase, sessionId);
    if (baseState === 'active') {
      return 'active';
    }
    sawDeadRuntimeStatus ||= baseState === 'dead';
    sawUnknownRuntimeStatus ||= baseState === 'unknown';
  }

  const scanResult = await scanRuntimeStatusUnderRoots(roots, sessionId);
  if (scanResult === 'active') {
    return 'active';
  }
  sawUnknownRuntimeStatus ||= scanResult === 'unknown';

  if (sawUnknownRuntimeStatus || !sawDeadRuntimeStatus) return 'unknown';
  return 'inactive';
}

function getRuntimeBaseCandidates(projectRoots: readonly string[]): string[] {
  const currentBase = path.resolve(Storage.getRuntimeBaseDir());
  const candidates = [currentBase];

  for (const root of projectRoots) {
    const rel = path.relative(root, currentBase);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    for (const candidateRoot of projectRoots) {
      candidates.push(path.resolve(candidateRoot, rel));
    }
  }

  return uniquePaths(candidates);
}

type RuntimeStatusState = 'active' | 'dead' | 'unknown' | 'missing';

async function getRuntimeStatusStateInBase(
  runtimeBase: string,
  sessionId: string,
): Promise<RuntimeStatusState> {
  const projectsDir = path.join(runtimeBase, 'projects');
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }

  let sawDeadRuntimeStatus = false;
  let sawUnknownRuntimeStatus = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const statusPath = path.join(
      projectsDir,
      entry.name,
      'chats',
      `${sessionId}.runtime.json`,
    );
    const statusState = await getRuntimeStatusPathState(statusPath, sessionId);
    if (statusState === 'active') {
      return 'active';
    }
    sawDeadRuntimeStatus ||= statusState === 'dead';
    sawUnknownRuntimeStatus ||= statusState === 'unknown';
  }
  if (sawUnknownRuntimeStatus) return 'unknown';
  return sawDeadRuntimeStatus ? 'dead' : 'missing';
}

type RuntimeStatusScanResult = 'active' | 'dead' | 'unknown' | 'not-found';

async function scanRuntimeStatusUnderRoots(
  roots: readonly string[],
  sessionId: string,
): Promise<RuntimeStatusScanResult> {
  const seen = new Set<string>();
  const state = { dirs: 0 };
  let sawDeadRuntimeStatus = false;
  let sawUnknownRuntimeStatus = false;
  for (const root of roots) {
    const result = await scanRuntimeStatusDir(root, sessionId, seen, state);
    if (result === 'active') {
      return result;
    }
    sawDeadRuntimeStatus ||= result === 'dead';
    sawUnknownRuntimeStatus ||= result === 'unknown';
  }
  if (sawUnknownRuntimeStatus) return 'unknown';
  return sawDeadRuntimeStatus ? 'dead' : 'not-found';
}

async function scanRuntimeStatusDir(
  dir: string,
  sessionId: string,
  seen: Set<string>,
  state: { dirs: number },
): Promise<RuntimeStatusScanResult> {
  if (state.dirs >= RUNTIME_STATUS_SCAN_MAX_DIRS) {
    return 'unknown';
  }
  state.dirs++;

  const realDir = await fs.realpath(dir).catch(() => path.resolve(dir));
  if (seen.has(realDir)) {
    return 'not-found';
  }
  seen.add(realDir);

  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'not-found';
    }
    throw error;
  }

  let sawDeadRuntimeStatus = false;
  let sawUnknownRuntimeStatus = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.name === 'projects') {
      const baseState = await getRuntimeStatusStateInBase(dir, sessionId);
      if (baseState === 'active') {
        return 'active';
      }
      sawDeadRuntimeStatus ||= baseState === 'dead';
      sawUnknownRuntimeStatus ||= baseState === 'unknown';
      continue;
    }
    if (shouldSkipRuntimeStatusScanDir(entry.name, dir)) {
      continue;
    }
    const result = await scanRuntimeStatusDir(child, sessionId, seen, state);
    if (result === 'active') return 'active';
    sawDeadRuntimeStatus ||= result === 'dead';
    sawUnknownRuntimeStatus ||= result === 'unknown';
  }

  if (sawUnknownRuntimeStatus) return 'unknown';
  return sawDeadRuntimeStatus ? 'dead' : 'not-found';
}

function shouldSkipRuntimeStatusScanDir(name: string, parent: string): boolean {
  if (RUNTIME_STATUS_SCAN_SKIP_DIRS.has(name)) {
    return true;
  }
  return name === 'worktrees' && path.basename(parent) === '.qwen';
}

async function getRuntimeStatusPathState(
  statusPath: string,
  sessionId: string,
): Promise<RuntimeStatusState> {
  const status = await readRuntimeStatus(statusPath);
  if (!status || status.sessionId !== sessionId) {
    return 'missing';
  }

  if (status.hostname !== os.hostname()) {
    return 'unknown';
  }

  try {
    process.kill(status.pid, 0);
    return 'active';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      return 'dead';
    }
    if (isNodeError(error) && error.code === 'EPERM') {
      return 'active';
    }
    return 'unknown';
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((value) => path.resolve(value)))];
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
 * Four "stale" cases produce sidecar cleanup so future `--resume` calls
 * don't keep tripping on the same broken state:
 * 1. ENOENT-followed-by-malformed-JSON (handled inside readWorktreeSession,
 *    which returns null without throwing for parse errors).
 * 2. The worktree directory referenced by a valid sidecar no longer exists.
 * 3. The sidecar exists but `readWorktreeSession` threw a non-ENOENT I/O
 *    error (e.g. permission, EIO) — we still attempt cleanup so the next
 *    resume isn't stuck reading the same broken file.
 * 4. The worktree marker is missing or no longer names the resumed session.
 *
 * Shared by TUI / headless / ACP entry points so all three behave
 * consistently on `--resume`. Failures are logged via the supplied
 * `onWarn` callback but never thrown — worktree restore is best-effort,
 * the session itself must still load.
 */
export async function restoreWorktreeContext(
  sidecarPath: string,
  onWarn?: (error: unknown) => void,
  expectedSessionId?: string,
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
  if (!resolvedWorktree.startsWith(expectedParent + path.sep)) {
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

  if (expectedSessionId !== undefined) {
    const markerOwner = await readWorktreeSessionMarker(session.worktreePath);
    if (markerOwner !== expectedSessionId) {
      onWarn?.(
        new Error(
          `Worktree marker owner ${markerOwner ?? '(missing)'} does not match ` +
            `session ${expectedSessionId}; clearing stale sidecar.`,
        ),
      );
      try {
        await clearWorktreeSession(sidecarPath);
      } catch (error) {
        onWarn?.(error);
      }
      return { contextMessage: null, session: null };
    }
  }

  return {
    session,
    contextMessage:
      `[Resumed] Active worktree: "${session.slug}" at ${session.worktreePath} ` +
      `(branch: ${session.worktreeBranch}). Continue using this path for all file operations.`,
  };
}
