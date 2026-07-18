/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Storage } from '../config/storage.js';

/**
 * Per-async-context session ID, mirroring {@link promptIdContext}.
 *
 * `QWEN_CODE_SESSION_ID` historically lived only in `process.env`, which is
 * a single process-global slot. That is fine for the interactive CLI (one
 * session per process, switched via a Config session transition), but breaks
 * in daemon mode where one process hosts many concurrent sessions: only the
 * first `Config` ever claims the env slot (see `sessionEnvClaimed` in
 * config.ts), so shells spawned by every later session would read a stale
 * session ID.
 *
 * Daemon-style hosts should wrap each session's execution entry points in
 * `sessionIdContext.run(sessionId, ...)`. `getShellContextEnvVars()` prefers
 * this context over `process.env`, falling back to the env var so the
 * single-session CLI behavior is unchanged.
 */
export const sessionIdContext = new AsyncLocalStorage<string>();

/**
 * Each session's project dir, keyed by its session id.
 *
 * A subprocess needs this to find the harness's records for *its* session, and
 * cannot recompute it: the project dir is derived from the session's launch cwd,
 * and a subprocess may have `cd`-ed elsewhere (the /review skill moves into a PR
 * worktree). So it is passed down through the environment.
 *
 * A single process-global slot would be wrong for the same reason a single
 * session-id slot is: in daemon mode one process serves many sessions, the slot
 * holds whichever booted first, and every later session would hand its
 * subprocesses another session's directory. Keyed on the session, it is right for
 * all of them.
 */
const LEGACY_PROJECT_DIR_OWNER = 'legacy';
interface SessionProjectDirRegistration {
  projectDir: string;
  runtimeBaseDir?: string;
}

const projectDirsBySession = new Map<
  string,
  Map<string, SessionProjectDirRegistration>
>();

export function registerSessionProjectDir(
  sessionId: string,
  projectDir: string,
  ownerId = LEGACY_PROJECT_DIR_OWNER,
  runtimeBaseDir?: string,
): void {
  if (!sessionId || !projectDir) return;
  let registrations = projectDirsBySession.get(sessionId);
  if (!registrations) {
    registrations = new Map();
    projectDirsBySession.set(sessionId, registrations);
  }
  registrations.delete(ownerId);
  registrations.set(ownerId, {
    projectDir,
    ...(runtimeBaseDir !== undefined ? { runtimeBaseDir } : {}),
  });
}

export function getSessionProjectDir(sessionId: string): string | undefined {
  const registrations = projectDirsBySession.get(sessionId);
  if (!registrations) return undefined;
  const ordered = [...registrations.values()];
  const runtimeBaseDir = Storage.getRuntimeBaseDir();
  const scoped = ordered
    .filter((registration) => registration.runtimeBaseDir === runtimeBaseDir)
    .at(-1);
  if (scoped) return scoped.projectDir;
  const legacy = ordered
    .filter((registration) => registration.runtimeBaseDir === undefined)
    .at(-1);
  if (legacy) return legacy.projectDir;
  return ordered.length === 1 ? ordered[0]?.projectDir : undefined;
}

/**
 * Drop a session's entry when it ends.
 *
 * The map would otherwise grow one entry per session for the life of a daemon
 * process. A session's own dispose path calls this; a single-session CLI never
 * needs to, since the process is the session.
 */
export function unregisterSessionProjectDir(
  sessionId: string,
  ownerId?: string,
): void {
  if (ownerId === undefined) {
    projectDirsBySession.delete(sessionId);
    return;
  }
  const registrations = projectDirsBySession.get(sessionId);
  if (!registrations) return;
  registrations.delete(ownerId);
  if (registrations.size === 0) projectDirsBySession.delete(sessionId);
}
