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
 *
 * One consequence of the boot prefix being the only machine identity: it
 * does not survive a reboot, and the model has no reboot-surviving
 * machine component to pair it with, so this machine's own records from
 * a PREVIOUS boot — provably dead, since a boot ending kills every
 * process in it — are indistinguishable from another machine's live
 * records. Both conservative rules above therefore also strand them: a
 * hard reset (power loss, panic, kill -9 plus reboot) leaves a record
 * nothing ever reclaims, and a later session that draws the same PID
 * number is refused by registration on the boot mismatch and stays
 * undiscoverable until the file is removed by hand.
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
  /**
   * Path to this session's peer-messaging socket, when it has one.
   *
   * Absent means the session is discoverable but not messageable — the
   * feature is off, or the inbox failed to bind. Readers must treat this
   * as a hint and dial the socket to confirm: a record can outlive the
   * process by the width of a crash, and a stale socket file still stats
   * fine.
   */
  ipcPath?: string;
  /**
   * Token a connection to `ipcPath` must present on its first line before
   * any frame is read. Published here because the record is 0600: being
   * able to read the token is the same capability as being able to
   * discover the socket at all, so senders get both in one read. Absent
   * on records written before the field existed — such an inbox cannot
   * be authenticated to and refuses frames.
   */
  ipcToken?: string;
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
 * The record path captured when registration succeeds. `getGlobalQwenDir()`
 * resolves a relative `QWEN_HOME` against the CURRENT `process.cwd()` on
 * every call, and `/cd` changes the cwd mid-session — so patch and
 * unregister must keep operating on the directory registration wrote to
 * rather than wherever the cwd moved afterwards. Null before a successful
 * registration (both seams no-op then anyway) and consumed by unregister.
 */
let registeredRecordPath: string | null = null;

/**
 * Test-only: clear the registration-path capture so a suite starts each
 * test from the unregistered state regardless of what an earlier test
 * registered. Without a reset, tests that need the capture null only
 * pass by accident of test order.
 */
export function resetRegisteredRecordPathForTest(): void {
  registeredRecordPath = null;
}

function thisProcessRecordPath(): string {
  return registeredRecordPath ?? getSessionRecordPath();
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
 * Letters, digits and combining marks are matched Unicode-aware: an
 * ASCII-only class would strip a CJK basename down to a bare dash,
 * leaving every such project with an identical, information-free label.
 * The basename is NFC-normalized first and combining marks are kept, so
 * an NFD accent (macOS' default normalization) or an Indic vowel sign is
 * not dashed away mid-word, and the cap counts code points rather than
 * UTF-16 units, so an astral character at the boundary cannot be cut
 * into a lone surrogate.
 */
export function deriveSessionName(cwd: string, sessionId: string): string {
  const base = Array.from(
    path
      .basename(cwd)
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  )
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
 * Returns true when the record was written. Returns false — without
 * writing — when the path is already held by a record carrying another
 * namespace's or another machine's identity, or one this build cannot
 * parse because of a newer schema version, or one whose read failed
 * transiently (an intact file cannot be proved unowned this moment): a
 * colliding session on the other side may be live, and overwriting its
 * record would hide it from discovery and destroy it when we exit.
 * Also refuses on Linux when the start token or the PID namespace id
 * stays unreadable after a retry — a tokenless record is impersonable
 * by any same-namespace reader, including another machine sharing the
 * home, and a namespace-less record is neither listed, patched nor
 * swept by any healthy reader, so it would poison its PID slot until
 * removed by hand. In all of these cases this session simply stays
 * undiscoverable.
 */
export async function registerSession(
  fields: RegisterSessionFields,
): Promise<boolean> {
  let procStart = readProcStartToken(process.pid);
  if (process.platform === 'linux' && procStart === null) {
    // Boot-id read failures are not cached, so a second attempt recovers
    // from the transient fd-pressure moment startup registration sits in.
    procStart = readProcStartToken(process.pid);
    if (procStart === null) {
      debugLogger.debug(
        'registerSession: start token unreadable; refusing to write an impersonable record',
      );
      return false;
    }
  }
  let pidNs = readPidNamespaceId();
  if (process.platform === 'linux' && pidNs === null) {
    // Same transient fd-pressure window as the start token above,
    // retried the same way. A namespace-less record is unreclaimable
    // litter on Linux: every healthy reader's own namespace is a
    // number, so the namespace guard hides the record from listing AND
    // from the sweep's unlink, every later patch fails
    // matchesLocalIdentity, and exit leaves it in place — poisoning
    // the PID slot for the next session. Refuse rather than write it.
    pidNs = readPidNamespaceId();
    if (pidNs === null) {
      debugLogger.debug(
        'registerSession: namespace id unreadable; refusing to write an unreclaimable record',
      );
      return false;
    }
  }
  const record: SessionRegistryRecord = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid: process.pid,
    procStart,
    pidNs,
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
    // destroy its record when we exit — refuse instead. The same holds
    // for a newer-schema record: readable, but not safely parsable. And
    // for a read that failed transiently (EMFILE, EIO, NFS ESTALE): the
    // file is intact and only momentarily out of reach, so the failure
    // must not be treated as "unowned".
    const existing = await readRecord(filePath);
    if (existing.status === 'read-error') {
      debugLogger.debug(
        'registerSession: record path read failed transiently; refusing to overwrite an intact record',
      );
      return false;
    }
    if (existing.status === 'unsupported-version') {
      debugLogger.debug(
        'registerSession: record path held by a newer-schema record',
      );
      return false;
    }
    if (existing.status === 'ok' && !matchesLocalIdentity(existing.record)) {
      debugLogger.debug(
        'registerSession: record path held by a foreign-identity record',
      );
      return false;
    }
    await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    // mkdir's mode is masked by the umask, and does nothing at all when
    // the directory already exists — chmod is what actually guarantees
    // 0700 on an upgrade from a build that created it more loosely.
    // Filesystems without POSIX permissions (FAT/exFAT, some FUSE
    // mounts) reject chmod with ENOSYS/ENOTSUP — tolerate exactly those
    // the way atomicWriteFile's tryChmod does for the record itself:
    // 0700 is unachievable there anyway, and aborting would hide this
    // session from every `ps` for its whole lifetime. Other errors
    // still abort the registration.
    try {
      await fs.chmod(dir, REGISTRY_DIR_MODE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOSYS' && code !== 'ENOTSUP') throw error;
    }
    await atomicWriteJSON(filePath, record, {
      mode: REGISTRY_FILE_MODE,
      forceMode: true,
      noFollow: true,
    });
    registeredRecordPath = filePath;
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
 *
 * Reports whether the patch was actually written: every skip below is
 * silent on the wire, and at least one caller (the peer inbox address
 * advertise) has no later event that would retry a skipped patch, so it
 * must be able to tell success from a no-op.
 */
export async function patchSessionRecord(
  patch: Partial<
    Omit<SessionRegistryRecord, 'pid' | 'schemaVersion' | 'procStart' | 'pidNs'>
  >,
): Promise<boolean> {
  try {
    // Inside the try: the fallback `getGlobalQwenDir()` resolution reads
    // the home directory and can throw, and this function promises never
    // to reject.
    const filePath = thisProcessRecordPath();
    const existing = await readRecord(filePath);
    // Missing, unreadable, newer-schema, or not actually a record for
    // this PID, namespace and boot: the path is keyed by PID alone, and
    // `readRecord` does not check the filename/contents agreement that
    // `listLiveSessions` insists on, so merging into a foreign record
    // would write back something the reader will neither show nor sweep
    // — permanent litter.
    if (existing.status !== 'ok' || !matchesLocalIdentity(existing.record)) {
      return false;
    }
    const record = existing.record;
    // The identity check alone also passes for a stale record left by a
    // DEAD previous incarnation of this PID (session A dies without
    // unlinking; the PID is recycled by session B whose registration
    // failed). A tokened record therefore also requires this process's
    // own token to be readable and to agree before merging — otherwise
    // the patch grafts B's fields onto A's record and lists the chimera
    // as live. When our own token is unreadable (the fd-pressure window
    // these patches run in), "cannot compare" means "not ours", the
    // same rule matchesLocalIdentity applies on write paths: skip this
    // patch and let a later /clear or /cd retry it.
    const currentToken = readProcStartToken(process.pid);
    if (record.procStart !== null && record.procStart !== currentToken) {
      return false;
    }
    await atomicWriteJSON(
      filePath,
      { ...record, ...patch },
      { mode: REGISTRY_FILE_MODE, forceMode: true, noFollow: true },
    );
    return true;
  } catch (error) {
    debugLogger.debug(`patchSessionRecord failed: ${describe(error)}`);
    return false;
  }
}

/** Remove this process's record. Safe to call when none was written. */
export async function unregisterSession(): Promise<void> {
  try {
    const filePath = thisProcessRecordPath();
    // Consume the capture regardless of the outcome below: after this
    // call returns, this process no longer holds a record at the path.
    registeredRecordPath = null;
    // The path is keyed by PID alone, and PIDs collide across namespace
    // and machine boundaries: the record sitting at our path may belong
    // to a live session on the other side of a shared home. Unlink only
    // what this side wrote; an unreadable one (a write torn by a crash)
    // cannot belong to anyone else and goes too. A newer-schema record
    // is readable but not safely parsable, so it might be — leave it,
    // and the same holds for a read that failed transiently: the file
    // is intact and may be a foreign live record.
    const existing = await readRecord(filePath);
    if (
      existing.status === 'unsupported-version' ||
      existing.status === 'read-error'
    ) {
      return;
    }
    if (existing.status === 'ok' && !matchesLocalIdentity(existing.record)) {
      return;
    }
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    debugLogger.debug(`unregisterSession failed: ${describe(error)}`);
  }
}

/**
 * This process's own record, as the registry currently holds it.
 *
 * Null when this session never registered, when its record is not
 * readable, or when the record at this PID's path was written by another
 * incarnation of the PID (another namespace, another boot, or a dead
 * predecessor whose token no longer matches) — the same tests
 * `patchSessionRecord` applies before it will merge into a record, so a
 * caller never reads back a record that a patch would have refused to
 * touch. Never throws.
 */
export async function readOwnSessionRecord(): Promise<SessionRegistryRecord | null> {
  try {
    const existing = await readRecord(thisProcessRecordPath());
    if (existing.status !== 'ok' || !matchesLocalIdentity(existing.record)) {
      return null;
    }
    const record = existing.record;
    const currentToken = readProcStartToken(process.pid);
    if (record.procStart !== null && record.procStart !== currentToken) {
      return null;
    }
    return record;
  } catch (error) {
    debugLogger.debug(`readOwnSessionRecord failed: ${describe(error)}`);
    return null;
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

      const read = await readRecord(filePath);
      // Malformed and newer-schema records are skipped without sweeping
      // — the list path never deletes what it cannot fully understand.
      if (read.status !== 'ok') return;
      const record = read.record;

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
      // never sweep it. The guard must not depend on OUR boot id being
      // readable: during the same outage `isSameProcess` degrades to a
      // bare liveness check, so a disabled guard here would let the
      // sweep unlink another machine's live record.
      const recordBootId =
        record.procStart === null ? null : bootIdOf(record.procStart);
      if (recordBootId !== null && recordBootId !== ownBootId) {
        return;
      }

      if (isSameProcess(record.pid, record.procStart)) {
        live.push(record);
        return;
      }

      // A registration can win this path between the liveness verdict
      // and the unlink: the recycled PID passes matchesLocalIdentity
      // against the stale record and renames its fresh record onto the
      // path. Re-read immediately before deleting and unlink only what
      // is still the record the verdict was computed from. `startedAt`
      // joins the comparison because on platforms without a start token
      // nothing else separates two incarnations of one PID number.
      const reread = await readRecord(filePath);
      if (
        reread.status !== 'ok' ||
        reread.record.pid !== record.pid ||
        reread.record.pidNs !== record.pidNs ||
        reread.record.procStart !== record.procStart ||
        reread.record.startedAt !== record.startedAt
      ) {
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
 * colliding writer on another side differs on. A missing token degrades
 * to the namespace comparison alone, matching `isSameProcess`'s
 * conservatism.
 *
 * An unreadable local boot id is different: `isSameProcess`'s
 * conservatism is "keep when unprovable", which is right for a read
 * path, but the callers here decide to OVERWRITE, MERGE or UNLINK — on
 * those write paths "cannot compare" must mean "not ours". A writer
 * that cannot read its boot id writes a tokenless record, so accepting
 * only tokenless records in this state costs nothing.
 */
function matchesLocalIdentity(record: SessionRegistryRecord): boolean {
  if (record.pid !== process.pid) return false;
  if (record.pidNs !== readPidNamespaceId()) return false;
  if (record.procStart === null) return true;
  const ownBootId = readLocalBootId();
  const recordBootId = bootIdOf(record.procStart);
  if (ownBootId === null) return recordBootId === null;
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

/**
 * One record file as read from disk: parsed, or unusable.
 *
 * `unreadable` covers a missing, corrupt or torn file — content this
 * code never wrote in a usable form. `read-error` is different: the
 * stat/read itself failed with something other than ENOENT (EMFILE,
 * EIO, NFS ESTALE), so the file is intact and only momentarily out of
 * reach — it may belong to a live foreign session, and the write paths
 * must refuse it the way they refuse `unsupported-version` instead of
 * treating it as unowned. `unsupported-version` is a well-formed record
 * written by a NEWER build: readable, and it may belong to a live
 * session this build cannot parse, so the write paths must treat it the
 * way they treat a parsed foreign-identity record.
 */
type ReadRecordResult =
  | { status: 'ok'; record: SessionRegistryRecord }
  | { status: 'unreadable' }
  | { status: 'read-error' }
  | { status: 'unsupported-version' };

const UNREADABLE: ReadRecordResult = { status: 'unreadable' };
const READ_ERROR: ReadRecordResult = { status: 'read-error' };
const UNSUPPORTED_VERSION: ReadRecordResult = {
  status: 'unsupported-version',
};

/** Read and validate one record, discriminating newer-schema files. */
async function readRecord(filePath: string): Promise<ReadRecordResult> {
  let raw: string;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return UNREADABLE;
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    // ENOENT (missing, or deleted between the stat and the read) is an
    // unowned path; any other coded failure is an intact file we cannot
    // read this moment.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return UNREADABLE;
    }
    return READ_ERROR;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return UNREADABLE;
  }
  const value = parsed as Record<string, unknown>;

  // Forward compatibility runs one way: a newer schema may add fields, so
  // an unknown *higher* version is reported as such rather than guessed
  // at — and, unlike a torn file, must not be treated as unowned.
  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'number') return UNREADABLE;
  if (schemaVersion > SESSION_REGISTRY_SCHEMA_VERSION) {
    return UNSUPPORTED_VERSION;
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
    return UNREADABLE;
  }

  const procStart = value['procStart'];
  const pidNs = value['pidNs'];
  const qwenVersion = value['qwenVersion'];
  const ipcPath = value['ipcPath'];
  const ipcToken = value['ipcToken'];

  return {
    status: 'ok',
    record: {
      schemaVersion,
      pid,
      procStart: typeof procStart === 'string' ? procStart : null,
      pidNs: typeof pidNs === 'number' && Number.isFinite(pidNs) ? pidNs : null,
      sessionId,
      cwd,
      name,
      startedAt,
      qwenVersion: typeof qwenVersion === 'string' ? qwenVersion : null,
      // Optional rather than nulled: absent and empty both mean "not
      // messageable", and a record written before this field existed must
      // read back identically to one written after it.
      ...(typeof ipcPath === 'string' && ipcPath.length > 0 ? { ipcPath } : {}),
      ...(typeof ipcToken === 'string' && ipcToken.length > 0
        ? { ipcToken }
        : {}),
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
