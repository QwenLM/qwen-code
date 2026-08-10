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
 * - It lives at `<projectDir>/chats/<sessionId>.runtime.json`, so finding
 *   every live session means walking every project directory and reading
 *   a file per *historical* session, not per live one. That cost grows
 *   with transcript history and would be paid on every lookup.
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
 * Version of the peer messaging contract this session speaks. Recorded so
 * a future sender can skip sessions that predate a protocol change
 * instead of writing frames they cannot parse. Bump on a breaking change
 * to the on-the-wire message shape.
 */
export const PEER_PROTOCOL_VERSION = 1;

/** Directory mode: the registry names live sessions and their work dirs. */
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

export type SessionKind = 'interactive' | 'headless';

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
  kind: SessionKind;
  /** Epoch milliseconds. */
  startedAt: number;
  qwenVersion: string | null;
  peerProtocol: number;
  /**
   * Path to this session's peer-messaging socket, when it has one.
   *
   * Absent means the session is discoverable but not messageable — the
   * feature is off, or the inbox failed to bind. Readers must treat this
   * as a hint and dial the socket to confirm: a record can outlive the
   * process by the width of a crash.
   */
  ipcPath?: string;
}

export interface RegisterSessionFields {
  sessionId: string;
  cwd: string;
  kind: SessionKind;
  qwenVersion?: string | null;
  /** Defaults to `process.pid`. Tests pass an explicit value. */
  pid?: number;
  /** Overrides the derived name. */
  name?: string;
}

export function getSessionRegistryDir(): string {
  return path.join(Storage.getGlobalQwenDir(), 'sessions');
}

export function getSessionRecordPath(pid: number = process.pid): string {
  return path.join(getSessionRegistryDir(), `${pid}.json`);
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
  // Unicode-aware on purpose: an ASCII-only class collapses a wholly
  // non-Latin basename (CJK, Cyrillic, ...) to a single `-`, which is
  // truthy — so the `'session'` fallback never fires and every such
  // project shows up as an indistinguishable `--<xx>`. Slicing by code
  // point rather than UTF-16 unit keeps an astral letter from being cut
  // in half at the 32-character boundary.
  const base = [...path.basename(cwd).replace(/[^\p{L}\p{N}._-]+/gu, '-')]
    .slice(0, 32)
    .join('');
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
  const pid = fields.pid ?? process.pid;
  const record: SessionRegistryRecord = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid,
    procStart: await readProcStartToken(pid),
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    name: fields.name ?? deriveSessionName(fields.cwd, fields.sessionId),
    kind: fields.kind,
    startedAt: Date.now(),
    qwenVersion: fields.qwenVersion ?? null,
    peerProtocol: PEER_PROTOCOL_VERSION,
  };

  try {
    const dir = getSessionRegistryDir();
    await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    // mkdir's mode is masked by the umask, and does nothing at all when
    // the directory already exists — chmod is what actually guarantees
    // 0700 on an upgrade from a build that created it more loosely.
    await fs.chmod(dir, REGISTRY_DIR_MODE);
    await atomicWriteJSON(getSessionRecordPath(pid), record, {
      mode: REGISTRY_FILE_MODE,
      forceMode: true,
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
  pid: number = process.pid,
): Promise<void> {
  const filePath = getSessionRecordPath(pid);
  try {
    const existing = await readRecord(filePath);
    if (existing === null) return;
    await atomicWriteJSON(
      filePath,
      { ...existing, ...patch },
      { mode: REGISTRY_FILE_MODE, forceMode: true },
    );
  } catch (error) {
    debugLogger.debug(`patchSessionRecord failed: ${describe(error)}`);
  }
}

/**
 * This process's own record, or null when it never registered.
 *
 * The sending side needs it: a message carries this session's reply
 * address and display name, and both live here rather than being
 * threaded down from the UI layer.
 *
 * Provenance is checked, not assumed. A record filed under our PID is
 * not necessarily ours: a session that was SIGKILLed leaves its record
 * behind, and the PID can then be recycled by a session that never
 * registered (`registerSession` tolerates ENOSPC/EROFS, and headless
 * runs skip it). Without this check that session would adopt the dead
 * one's identity — passing the peer-send gate on the dead `ipcPath`
 * and stamping frames with the dead `from`/`fromName`, so replies and
 * receipts dial a socket nobody is listening on. On platforms with no
 * start token this degrades to the previous trust-by-PID behaviour,
 * which is all the platform can support.
 */
export async function readOwnSessionRecord(
  pid: number = process.pid,
): Promise<SessionRegistryRecord | null> {
  const record = await readRecord(getSessionRecordPath(pid));
  if (record === null) return null;
  return (await isSameProcess(record.pid, record.procStart)) ? record : null;
}

/** Remove this process's record. Safe to call when none was written. */
export async function unregisterSession(
  pid: number = process.pid,
): Promise<void> {
  try {
    await fs.unlink(getSessionRecordPath(pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    debugLogger.debug(`unregisterSession failed: ${describe(error)}`);
  }
}

export interface ListLiveSessionsOptions {
  /** Include the calling process's own record. Defaults to false. */
  includeSelf?: boolean;
  /** Overrides `process.pid` when deciding what "self" means. */
  selfPid?: number;
  /**
   * Delete records proven to belong to a dead process. Defaults to true;
   * read-only callers can turn it off.
   */
  sweepStale?: boolean;
  /**
   * Propagate a non-ENOENT failure to read the registry directory instead
   * of degrading to an empty list. Defaults to false: discovery callers
   * treat "no peers" and "cannot look" alike, but a command that REPORTS
   * the registry (like `sessions ps`) must not turn "cannot look" into a
   * false "there is nothing running".
   */
  throwOnReadError?: boolean;
}

/**
 * Enumerate live sessions, newest first, sweeping records whose process
 * is provably gone.
 *
 * A missing registry directory is always an empty list. An UNREADABLE one
 * is an empty list too unless `throwOnReadError` is set — discovery
 * callers want "no peers" and "cannot look" collapsed, but a command that
 * reports the registry must be able to tell them apart.
 */
export async function listLiveSessions(
  options: ListLiveSessionsOptions = {},
): Promise<SessionRegistryRecord[]> {
  const {
    includeSelf = false,
    selfPid = process.pid,
    sweepStale = true,
    throwOnReadError = false,
  } = options;

  const dir = getSessionRegistryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      if (throwOnReadError) throw error;
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

        if (record.pid === selfPid) {
          // Never sweep a record filed under our own PID: that PID is
          // alive by definition, so nothing here can prove the record
          // dead, and deleting it would race a sibling that legitimately
          // owns it. Enumeration still has to check provenance — a
          // recycled PID means the record may predate this process (see
          // `readOwnSessionRecord`) — it just declines to delete it.
          if (
            includeSelf &&
            (await isSameProcess(record.pid, record.procStart))
          ) {
            live.push(record);
          }
          return;
        }

        if (await isSameProcess(record.pid, record.procStart)) {
          live.push(record);
          return;
        }

        if (sweepStale) {
          try {
            // Re-verify immediately before deleting: between the check
            // above and this unlink, the PID can be recycled and its new
            // owner can atomically rewrite the record. Deleting by
            // pathname alone would then destroy a live session's fresh
            // record, so only delete a file that still holds the exact
            // record this pass proved stale.
            const current = await readRecord(filePath);
            if (
              current !== null &&
              current.pid === record.pid &&
              current.sessionId === record.sessionId &&
              current.startedAt === record.startedAt &&
              current.procStart === record.procStart &&
              !(await isSameProcess(current.pid, current.procStart))
            ) {
              await fs.unlink(filePath);
            }
          } catch {
            // Raced with another session's sweep, or not ours to delete.
          }
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
  const kind = value['kind'];
  const startedAt = value['startedAt'];
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof sessionId !== 'string' ||
    typeof cwd !== 'string' ||
    typeof name !== 'string' ||
    (kind !== 'interactive' && kind !== 'headless') ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  ) {
    return null;
  }

  const procStart = value['procStart'];
  const qwenVersion = value['qwenVersion'];
  const peerProtocol = value['peerProtocol'];
  const ipcPath = value['ipcPath'];

  return {
    schemaVersion,
    pid,
    procStart: typeof procStart === 'string' ? procStart : null,
    sessionId,
    cwd,
    name,
    kind,
    startedAt,
    qwenVersion: typeof qwenVersion === 'string' ? qwenVersion : null,
    peerProtocol: typeof peerProtocol === 'number' ? peerProtocol : 0,
    ...(typeof ipcPath === 'string' && ipcPath.length > 0 ? { ipcPath } : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
