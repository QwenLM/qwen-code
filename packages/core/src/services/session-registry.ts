/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A machine-wide index of the Qwen Code sessions that are running right
 * now.
 *
 * Each top-level session writes `~/.qwen/sessions/<pid>.json` at startup
 * and unlinks it on exit. The directory is flat and keyed by PID so that
 * "who else is running on this box" is one `readdir` plus a handful of
 * small reads.
 *
 * ## Why this is not `runtime.json`
 *
 * {@link ../utils/runtimeStatus.ts} already writes a per-session sidecar,
 * but it answers a different question and cannot serve this one:
 *
 * - It lives at `<projectDir>/chats/<sessionId>.runtime.json`, so it is
 *   indexed by session id rather than by liveness. `isSessionRuntimeActive`
 *   in `worktreeSessionService.ts` shows what the reverse lookup costs
 *   there: candidate runtime-base guessing plus a recursive scan, to
 *   answer the question for a *single already-known* session id.
 * - It is deliberately never deleted — not on clean quit, not on crash —
 *   so presence carries no liveness signal at all.
 *
 * The two coexist: `runtime.json` stays the stable, kimi-compatible
 * "which session is PID X serving" sidecar for external observers, and
 * this registry is the discovery index for the CLI's own features.
 *
 * ## Staleness
 *
 * A record is live when its PID is running *and* the recorded process
 * start token still matches (see `isSameProcess`) — a recycled PID must
 * not resurrect a dead session. Records that fail that check are swept
 * during enumeration; anything we cannot positively prove dead is left
 * alone.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isSameProcess,
  readProcStartToken,
} from '../utils/process-liveness.js';

const debugLogger = createDebugLogger('SESSION_REGISTRY');

export const SESSION_REGISTRY_SCHEMA_VERSION = 1;

/**
 * 0700 keeps the listing — session names and their work dirs — readable
 * only by its owner. The records are also written `noFollow`, so a
 * pre-planted symlink at `<pid>.json` cannot redirect a registration
 * write elsewhere; `session-writer-lease.ts` gets the same guard from
 * `O_NOFOLLOW`.
 */
const REGISTRY_DIR_MODE = 0o700;
const REGISTRY_FILE_MODE = 0o600;

/** Refuse to parse anything larger; a record is a few hundred bytes. */
const MAX_RECORD_BYTES = 64 * 1024;

/**
 * Only `<digits>.json` is a candidate record.
 *
 * This is deliberately strict. A lenient `parseInt` prefix match would
 * read `2026-planning-notes.json` as PID 2026, fail its liveness check,
 * and delete a file this code never wrote.
 */
const RECORD_FILENAME = /^\d+\.json$/;

/** One live session, as recorded on disk. */
export interface SessionRegistryRecord {
  schemaVersion: number;
  pid: number;
  /** Start-time token guarding against PID reuse; null where unavailable. */
  procStart: string | null;
  sessionId: string;
  cwd: string;
  /** Short human-facing label, unique-ish per session. */
  name: string;
  /** Epoch milliseconds. */
  startedAt: number;
  qwenVersion: string | null;
}

export interface RegisterSessionFields {
  sessionId: string;
  cwd: string;
  qwenVersion?: string | null;
}

export function getSessionRegistryDir(): string {
  return path.join(Storage.getGlobalQwenDir(), 'sessions');
}

/** This process's record path. Records are keyed by PID. */
export function getSessionRecordPath(): string {
  return path.join(getSessionRegistryDir(), `${process.pid}.json`);
}

/**
 * A short, stable, human-readable label: the working directory's basename
 * plus two hex characters derived from the session id.
 *
 * The suffix exists because two sessions in the same directory is the
 * common case, not the exception — bare `qwen-code` would collide
 * immediately. Two hex characters keep it typeable while making a
 * same-directory collision unlikely rather than certain; callers that
 * need a guaranteed-unique handle should use the session id.
 */
export function deriveSessionName(cwd: string, sessionId: string): string {
  const base = path
    .basename(cwd)
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 32);
  const suffix = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 2);
  return `${base || 'session'}-${suffix}`;
}

/**
 * Write this process's record. Best-effort: a read-only or full home
 * directory must not stop a session from starting, so failures are logged
 * and reported, never thrown.
 *
 * Returns true when the record was written.
 */
export async function registerSession(
  fields: RegisterSessionFields,
): Promise<boolean> {
  const record: SessionRegistryRecord = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    name: deriveSessionName(fields.cwd, fields.sessionId),
    startedAt: Date.now(),
    qwenVersion: fields.qwenVersion ?? null,
  };

  try {
    const dir = getSessionRegistryDir();
    await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    // mkdir's mode is masked by the umask, and does nothing at all when
    // the directory already exists — chmod is what actually guarantees
    // 0700 on an upgrade from a build that created it more loosely.
    await fs.chmod(dir, REGISTRY_DIR_MODE);
    await atomicWriteJSON(getSessionRecordPath(), record, {
      mode: REGISTRY_FILE_MODE,
      forceMode: true,
      noFollow: true,
    });
    return true;
  } catch (error) {
    debugLogger.debug(`registerSession failed: ${describe(error)}`);
    return false;
  }
}

/**
 * Merge `patch` into this process's record.
 *
 * Used when a field changes mid-session — `/clear`, `/resume` and friends
 * swap the session id under a stable PID, and a record still advertising
 * the old id points readers at the wrong transcript.
 *
 * No-ops when the record is missing: a session that failed to register
 * should not be resurrected by a later patch, because the resurrected
 * record would be missing whatever else registration would have set.
 */
export async function patchSessionRecord(
  patch: Partial<Omit<SessionRegistryRecord, 'pid' | 'schemaVersion'>>,
): Promise<void> {
  const filePath = getSessionRecordPath();
  try {
    const existing = await readRecord(filePath);
    // Missing, or not actually a record for this PID: `readRecord` does
    // not check the filename/contents agreement that `listLiveSessions`
    // insists on, so merging into a foreign `<pid>.json` would write back
    // a record the reader will neither show nor sweep — permanent litter.
    if (existing === null || existing.pid !== process.pid) return;
    await atomicWriteJSON(
      filePath,
      { ...existing, ...patch },
      { mode: REGISTRY_FILE_MODE, forceMode: true, noFollow: true },
    );
  } catch (error) {
    debugLogger.debug(`patchSessionRecord failed: ${describe(error)}`);
  }
}

/** Remove this process's record. Safe to call when none was written. */
export async function unregisterSession(): Promise<void> {
  try {
    await fs.unlink(getSessionRecordPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    debugLogger.debug(`unregisterSession failed: ${describe(error)}`);
  }
}

/**
 * Enumerate live sessions, newest first, sweeping records whose process
 * is provably gone.
 *
 * Returns an empty list rather than throwing when the registry directory
 * is missing or unreadable — "no peers" and "cannot look" are the same
 * outcome for every caller, and this sits on interactive paths.
 */
export async function listLiveSessions(): Promise<SessionRegistryRecord[]> {
  let dir: string;
  let entries: string[];
  try {
    // Inside the try as well: `getGlobalQwenDir()` resolves the home
    // directory and can throw. Callers are told this never throws, and
    // `ps` dropped its error path on the strength of that promise.
    dir = getSessionRegistryDir();
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      debugLogger.debug(`listLiveSessions readdir failed: ${describe(error)}`);
    }
    return [];
  }

  const live: SessionRegistryRecord[] = [];
  await Promise.all(
    entries
      .filter((name) => RECORD_FILENAME.test(name))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        const record = await readRecord(filePath);
        if (record === null) return;

        // A record whose filename disagrees with its contents was not
        // written by this code (or was renamed by hand). Skip it, and
        // never sweep it — we cannot reason about which PID it describes.
        if (`${record.pid}.json` !== name) return;

        if (isSameProcess(record.pid, record.procStart)) {
          live.push(record);
          return;
        }

        try {
          await fs.unlink(filePath);
        } catch {
          // Raced with another session's sweep, or not ours to delete.
        }
      }),
  );

  return live.sort((a, b) => b.startedAt - a.startedAt);
}

/** Read and validate one record. Returns null for anything unusable. */
async function readRecord(
  filePath: string,
): Promise<SessionRegistryRecord | null> {
  let raw: string;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;

  // Forward compatibility runs one way: a newer schema may add fields, so
  // an unknown *higher* version is skipped rather than guessed at.
  const schemaVersion = value['schemaVersion'];
  if (
    typeof schemaVersion !== 'number' ||
    schemaVersion > SESSION_REGISTRY_SCHEMA_VERSION
  ) {
    return null;
  }

  const pid = value['pid'];
  const sessionId = value['sessionId'];
  const cwd = value['cwd'];
  const name = value['name'];
  const startedAt = value['startedAt'];
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof sessionId !== 'string' ||
    typeof cwd !== 'string' ||
    typeof name !== 'string' ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  ) {
    return null;
  }

  const procStart = value['procStart'];
  const qwenVersion = value['qwenVersion'];

  return {
    schemaVersion,
    pid,
    procStart: typeof procStart === 'string' ? procStart : null,
    sessionId,
    cwd,
    name,
    startedAt,
    qwenVersion: typeof qwenVersion === 'string' ? qwenVersion : null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
