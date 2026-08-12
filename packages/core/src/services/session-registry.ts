/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An index of the Qwen Code sessions that are running right now.
 *
 * Each top-level session writes `<global dir>/sessions/<pid>.json` at
 * startup and unlinks it on exit. The directory is flat and keyed by PID
 * so that "who else is running" is one `readdir` plus a handful of small
 * reads.
 *
 * The index is scoped to one Qwen home: the global dir resolves
 * `QWEN_HOME` on every call, so a session started under a redirected
 * `QWEN_HOME` registers elsewhere and stays invisible to readers under
 * the default home (and vice versa). It also assumes a single machine on
 * platforms without a start token: there, no identity separates two
 * machines sharing one home, so the registry does not support that.
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
 * A record is live when it was written from the reader's own PID
 * namespace and boot, its PID is running *and* the recorded process
 * start token still matches (see `isSameProcess`) — a recycled PID must
 * not resurrect a dead session. Records that fail the liveness check are
 * swept during enumeration; records from another PID namespace — or from
 * another machine's boot, which the namespace inode alone does not
 * separate, because the initial namespace inode is a kernel constant
 * identical on every Linux machine — are neither listed nor swept,
 * because PID numbers do not resolve across those boundaries in either
 * direction. The same isolation extends to records whose writer's
 * namespace no longer exists (an ephemeral container destroyed without
 * cleanup): no future reader shares that namespace, so the record is
 * never reclaimed and stays until removed by hand. Anything else we
 * cannot positively prove dead is left alone.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isSameProcess,
  readLocalBootId,
  readPidNamespaceId,
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

/**
 * Temp files left by `atomicWriteJSON` next to their target. Matched
 * separately from `RECORD_FILENAME` so enumeration can reap the orphans
 * a crashed registration leaves behind (see `sweepOrphanedTempFile`).
 */
const TEMP_FILENAME = /^\d+\.json\.[0-9a-f]{12}\.tmp$/;

/** Younger temps may belong to a writer mid-rename — leave them alone. */
const TEMP_MAX_AGE_MS = 5 * 60 * 1000;

/** One live session, as recorded on disk. */
export interface SessionRegistryRecord {
  schemaVersion: number;
  pid: number;
  /** Start-time token guarding against PID reuse; null where unavailable. */
  procStart: string | null;
  /**
   * PID-namespace identity of the writer (see `readPidNamespaceId`);
   * null where the platform does not expose one.
   */
  pidNs: number | null;
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

/**
 * This process's record path. Records are keyed by PID, which collides
 * across PID namespaces and machines; the identity fields inside a
 * record (`pidNs`, the token's boot prefix) decide which side owns a
 * colliding path.
 */
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
 *
 * Letters and digits are matched Unicode-aware: an ASCII-only class would
 * strip a CJK basename down to a bare dash, leaving every such project
 * with an identical, information-free label.
 */
export function deriveSessionName(cwd: string, sessionId: string): string {
  const base = path
    .basename(cwd)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
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
 * Returns true when the record was written. Returns false — without
 * writing — when the path is already held by a record carrying another
 * namespace's or another machine's identity: a colliding session on the
 * other side is live, and overwriting its record would hide it from
 * discovery and destroy it when we exit. This session then simply stays
 * undiscoverable.
 */
export async function registerSession(
  fields: RegisterSessionFields,
): Promise<boolean> {
  const record: SessionRegistryRecord = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    pidNs: readPidNamespaceId(),
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    name: deriveSessionName(fields.cwd, fields.sessionId),
    startedAt: Date.now(),
    qwenVersion: fields.qwenVersion ?? null,
  };

  try {
    const dir = getSessionRegistryDir();
    const filePath = getSessionRecordPath();
    // A record already at our path may belong to a live session that
    // collided with us on the PID number across a namespace or machine
    // boundary (host + devcontainer, sibling containers, NFS-shared
    // homes). Overwriting it would hide that session from discovery and
    // destroy its record when we exit — refuse instead.
    const existing = await readRecord(filePath);
    if (existing !== null && !matchesLocalIdentity(existing)) {
      debugLogger.debug(
        'registerSession: record path held by a foreign-identity record',
      );
      return false;
    }
    await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    // mkdir's mode is masked by the umask, and does nothing at all when
    // the directory already exists — chmod is what actually guarantees
    // 0700 on an upgrade from a build that created it more loosely.
    await fs.chmod(dir, REGISTRY_DIR_MODE);
    await atomicWriteJSON(filePath, record, {
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
 * `procStart` and `pidNs` are excluded from the patch for the same
 * reason the pid is: they are the identity the sweep trusts, and a
 * caller-supplied value could only corrupt it.
 */
export async function patchSessionRecord(
  patch: Partial<
    Omit<SessionRegistryRecord, 'pid' | 'schemaVersion' | 'procStart' | 'pidNs'>
  >,
): Promise<void> {
  try {
    // Inside the try: `getGlobalQwenDir()` resolves the home directory
    // and can throw, and this function promises never to reject.
    const filePath = getSessionRecordPath();
    const existing = await readRecord(filePath);
    // Missing, or not actually a record for this PID, namespace and
    // boot: the path is keyed by PID alone, and `readRecord` does not
    // check the filename/contents agreement that `listLiveSessions`
    // insists on, so merging into a foreign record would write back
    // something the reader will neither show nor sweep — permanent
    // litter.
    if (existing === null || !matchesLocalIdentity(existing)) return;
    // The identity check alone also passes for a stale record left by a
    // DEAD previous incarnation of this PID (session A dies without
    // unlinking; the PID is recycled by session B whose registration
    // failed). When both sides carry a start token, require it to agree
    // before merging — otherwise the patch grafts B's fields onto A's
    // record and lists the chimera as live.
    const currentToken = readProcStartToken(process.pid);
    if (
      existing.procStart !== null &&
      currentToken !== null &&
      existing.procStart !== currentToken
    ) {
      return;
    }
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
    const filePath = getSessionRecordPath();
    // The path is keyed by PID alone, and PIDs collide across namespace
    // and machine boundaries: the record sitting at our path may belong
    // to a live session on the other side of a shared home. Unlink only
    // what this side wrote; an unreadable one (a write torn by a crash)
    // cannot belong to anyone else and goes too.
    const existing = await readRecord(filePath);
    if (existing !== null && !matchesLocalIdentity(existing)) return;
    await fs.unlink(filePath);
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

  const ownNamespace = readPidNamespaceId();
  const ownBootId = readLocalBootId();
  const live: SessionRegistryRecord[] = [];
  await Promise.all(
    entries.map(async (name) => {
      const filePath = path.join(dir, name);
      if (!RECORD_FILENAME.test(name)) {
        await sweepOrphanedTempFile(filePath, name);
        return;
      }

      const record = await readRecord(filePath);
      if (record === null) return;

      // A record whose filename disagrees with its contents was not
      // written by this code (or was renamed by hand). Skip it, and
      // never sweep it — we cannot reason about which PID it describes.
      if (`${record.pid}.json` !== name) return;

      // A record from another PID namespace describes PIDs that do not
      // resolve in ours: kill(pid, 0) reports ESRCH for a process that
      // is alive over there, and a "matching" starttime can belong to
      // an unrelated process. Neither listing nor sweeping is safe —
      // leave it to a reader on the writer's own side.
      if (record.pidNs !== ownNamespace) return;

      // The namespace inode does not separate machines either: the
      // initial-namespace inode is a kernel constant identical on every
      // Linux machine, and a shared home (NFS/AFS) lets two machines
      // write one directory. A token whose boot prefix names another
      // boot names another machine — its PIDs resolve to the wrong
      // processes here, so leave it to a reader on its own side, and
      // never sweep it.
      const recordBootId =
        record.procStart === null ? null : bootIdOf(record.procStart);
      if (
        ownBootId !== null &&
        recordBootId !== null &&
        recordBootId !== ownBootId
      ) {
        return;
      }

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

/**
 * True when a record found at this process's path was written from this
 * PID namespace and this boot. The path is keyed by PID alone, and PID
 * numbers collide across both boundaries; these are the fields a
 * colliding writer on another side differs on. A missing token or an
 * unreadable local boot id degrades to the namespace comparison alone,
 * matching `isSameProcess`'s conservatism.
 */
function matchesLocalIdentity(record: SessionRegistryRecord): boolean {
  if (record.pid !== process.pid) return false;
  if (record.pidNs !== readPidNamespaceId()) return false;
  if (record.procStart === null) return true;
  const ownBootId = readLocalBootId();
  if (ownBootId === null) return true;
  const recordBootId = bootIdOf(record.procStart);
  return recordBootId === null || recordBootId === ownBootId;
}

/** The boot-id prefix of a `<boot_id>:<starttime>` token, or null. */
function bootIdOf(procStart: string): string | null {
  const sep = procStart.indexOf(':');
  return sep === -1 ? null : procStart.slice(0, sep);
}

/**
 * Reap a crashed registration's temp file. `atomicWriteJSON` writes
 * `<pid>.json.<12hex>.tmp` and renames; a writer that dies in between
 * (kill -9, OOM, power loss) leaves the temp behind, and nothing else
 * ever removes it. The age check spares a writer mid-rename.
 */
async function sweepOrphanedTempFile(
  filePath: string,
  name: string,
): Promise<void> {
  if (!TEMP_FILENAME.test(name)) return;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return;
    if (Date.now() - stat.mtimeMs < TEMP_MAX_AGE_MS) return;
    await fs.unlink(filePath);
  } catch {
    // Raced with the writer's rename or another sweeper.
  }
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
  const pidNs = value['pidNs'];
  const qwenVersion = value['qwenVersion'];

  return {
    schemaVersion,
    pid,
    procStart: typeof procStart === 'string' ? procStart : null,
    pidNs: typeof pidNs === 'number' && Number.isFinite(pidNs) ? pidNs : null,
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
