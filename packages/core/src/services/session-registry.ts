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
 *
 * That liveness probe is only meaningful inside one PID namespace on one
 * machine, and this directory can span both: the sandbox mounts the
 * host's global qwen dir into a container that gets its own PID
 * namespace, and `QWEN_HOME` on a shared volume points two machines at
 * one directory. Either way both sides read each other's records while
 * neither can see the other's processes. Each record therefore carries
 * its *origin* — the machine and the PID namespace it was written in (see
 * `readMachineId` and `readPidNamespaceId`) — and everything here ignores
 * records from another origin: enumeration neither lists nor sweeps them,
 * and the write paths neither overwrite, patch nor unlink them. A
 * namespace-local `ESRCH` is not proof of death for a shared directory,
 * and `<pid>.json` is not proof of ownership.
 *
 * Two origins can still *want* the same `<pid>.json`, because the key is
 * a bare PID. The loser of that collision is simply absent from
 * discovery, which is the safe half of the trade: a durable fix needs
 * origin-disambiguated keying, not a wider guard here.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isSameProcess,
  PID_NAMESPACE_UNREADABLE,
  readMachineId,
  readPidNamespaceId,
  readProcStartToken,
  supportsProcStartToken,
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

/**
 * How many candidate records one enumeration will look at, and how many of
 * those reads may be in flight at once.
 *
 * Both filename and file count are attacker-supplied under this
 * directory's own threat model: a sandboxed co-tenant can create
 * `<digits>.json` at will, and an unbounded `Promise.all` over `readdir`
 * would then open a descriptor and allocate a promise per entry in one
 * tick. `qwen sessions ps` sits on an interactive path with no back
 * pressure of its own, so the ceiling has to live here. A real machine
 * runs single-digit sessions; 512 is far above any honest reading and far
 * below the point where either resource matters.
 */
const MAX_RECORDS_PER_SCAN = 512;
const SCAN_CONCURRENCY = 16;

/**
 * `O_NOFOLLOW` does not exist on Windows, where `fs.constants` simply
 * omits it; `| undefined` would poison the whole flag word into `NaN`.
 * Zero is the correct degradation — Windows has no symlink-in-a-shared-
 * home threat model here, and every other guard still applies.
 *
 * Read at the call site rather than at module load. This module is
 * reachable from `config.ts` and from the package barrel, so a top-level
 * `fs.constants` read makes module *initialization* depend on that export
 * and takes down every consumer that substitutes `node:fs` without it.
 */
function noFollowFlag(): number {
  return fsSync.constants.O_NOFOLLOW ?? 0;
}

/** A directory entry's identity, as observed through an open handle. */
interface EntryIdentity {
  dev: number;
  ino: number;
}

/** A validated record together with the entry the bytes came from. */
interface ReadRecord {
  record: SessionRegistryRecord;
  entry: EntryIdentity;
}

export type SessionKind = 'interactive' | 'headless';

/** One live session, as recorded on disk. */
export interface SessionRegistryRecord {
  schemaVersion: number;
  pid: number;
  /** Start-time token guarding against PID reuse; null where unavailable. */
  procStart: string | null;
  /**
   * The PID namespace `pid` was allocated in; null where the platform has
   * no such concept. Readers that cannot match it against their own must
   * treat the PID as unreadable rather than dead.
   */
  pidNamespace: string | null;
  /**
   * The machine `pid` was allocated on; null where none could be read.
   * Same rule as `pidNamespace`, and needed alongside it: the initial PID
   * namespace id is identical on every non-containerized Linux host, so
   * that field alone lets one machine read another's PIDs as its own.
   */
  machineId: string | null;
  sessionId: string;
  cwd: string;
  /** Short human-facing label, unique-ish per session. */
  name: string;
  kind: SessionKind;
  /** Epoch milliseconds. */
  startedAt: number;
  qwenVersion: string | null;
  peerProtocol: number;
}

export interface RegisterSessionFields {
  sessionId: string;
  cwd: string;
  kind: SessionKind;
  qwenVersion?: string | null;
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Overrides the derived name. */
  name?: string;
  /**
   * Called when registration is refused because `<pid>.json` already
   * holds another origin's record.
   *
   * A plain `false` cannot carry this: every other failure is an I/O
   * error that is silent by design, whereas this one is indefinite.
   * Nothing sweeps an ownerless foreign record — sweep, unregister and
   * patch all skip foreign origins — and registration is startup-only, so
   * this session stays invisible to discovery for its entire lifetime,
   * and so does every later session that draws the same PID. Core has no
   * business picking a presentation channel, so the caller is handed the
   * fact and decides.
   */
  onOriginConflict?: (info: { pid: number; filePath: string }) => void;
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
 * True when `record` was written from this machine and this PID
 * namespace — the only case in which `record.pid` is a number this
 * process can probe, and the only case in which `<pid>.json` is this
 * process's to write.
 *
 * Compared strictly, nulls included: two nulls is the no-identity case
 * (a platform that exposes neither) and stays on the original
 * trust-the-path behaviour, while a null on one side only means the
 * writer made no claim we can check.
 *
 * {@link PID_NAMESPACE_UNREADABLE} is the one value that never matches,
 * not even itself. `null` is a claim — "this platform has no namespaces" —
 * and two peers making it are genuinely in the same (non-existent)
 * namespace. The sentinel is the absence of a claim on a platform that
 * *does* have namespaces, so two sides carrying it have established
 * nothing: two containers behind a `hidepid` mount, sharing a machine id
 * and a `QWEN_HOME`, would otherwise read each other's PID numbers as
 * their own.
 */
function isSameOrigin(
  record: Pick<SessionRegistryRecord, 'machineId' | 'pidNamespace'>,
  selfMachine: string | null,
  selfNamespace: string | null,
): boolean {
  if (
    record.pidNamespace === PID_NAMESPACE_UNREADABLE ||
    selfNamespace === PID_NAMESPACE_UNREADABLE
  ) {
    return false;
  }
  return (
    record.machineId === selfMachine && record.pidNamespace === selfNamespace
  );
}

/**
 * Serializes this process's own registry writes, so `unregisterSession`
 * and an in-flight `patchSessionRecord` can never interleave.
 *
 * `Config.refreshSessionId` queues its patch on a fire-and-forget chain
 * and returns without awaiting it, so a `/clear` immediately before quit
 * can still be between its read and its write when exit cleanup runs. In
 * that interleaving the unlink lands in the middle and the patch's write
 * then *recreates* the record — a file advertising a PID that has already
 * exited, which stands until some other session's sweep happens to notice.
 * Ordering the two removes the interleaving; {@link retiredPids} handles
 * the other direction, where the patch is merely queued behind the unlink
 * and would otherwise resurrect it just the same.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * PIDs whose record this process has already withdrawn. A later patch for
 * one is dropped rather than allowed to write the record back.
 */
const retiredPids = new Set<number>();

function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  // Both arms run `op`: a failed predecessor must not cancel its
  // successor, since each of these is independently best-effort.
  const run = writeQueue.then(op, op);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Reject a write whose target is no longer the entry that was validated.
 *
 * `readRecord` proves things about an *inode* — its origin, its PID, that
 * it parses — but every mutation that follows names a *path*, and in a
 * directory a sandboxed co-tenant can write to, the two stop agreeing the
 * moment the read returns: the entry can be unlinked and replaced with a
 * foreign live record, which `patchSessionRecord` would then overwrite and
 * `unregisterSession` would delete. Re-reading the entry immediately
 * before the commit step binds them back together.
 *
 * `lstatSync` rather than the async form because `assertCanCommit` is the
 * hook that runs *between* the last check and an irreversible `rename`;
 * an `await` there would reopen the very window this closes.
 */
function assertSameEntry(filePath: string, expected: EntryIdentity): void {
  const stat = fsSync.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino
  ) {
    throw new Error(
      `session registry entry ${filePath} changed between validation and write`,
    );
  }
}

/**
 * Write this process's record. Best-effort: a read-only or full home
 * directory must not stop a session from starting, so failures are logged
 * and reported, never thrown.
 *
 * Returns true when the record was written. Returns false — without
 * touching the file — when `<pid>.json` already holds a record from
 * another origin: that PID number belongs to someone else's namespace or
 * machine, and overwriting it would both destroy a live session's
 * discovery entry and point readers at the wrong transcript.
 */
export async function registerSession(
  fields: RegisterSessionFields,
): Promise<boolean> {
  const pid = fields.pid ?? process.pid;
  const record: SessionRegistryRecord = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    pid,
    procStart: readProcStartToken(pid),
    pidNamespace: readPidNamespaceId(),
    machineId: readMachineId(),
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    name: fields.name ?? deriveSessionName(fields.cwd, fields.sessionId),
    kind: fields.kind,
    startedAt: Date.now(),
    qwenVersion: fields.qwenVersion ?? null,
    peerProtocol: PEER_PROTOCOL_VERSION,
  };

  return enqueueWrite(async () => {
    try {
      const dir = getSessionRegistryDir();
      await fs.mkdir(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
      // mkdir's mode is masked by the umask, and does nothing at all when
      // the directory already exists — chmod is what actually guarantees
      // 0700 on an upgrade from a build that created it more loosely.
      await fs.chmod(dir, REGISTRY_DIR_MODE);

      const filePath = getSessionRecordPath(pid);
      const reportConflict = () => {
        debugLogger.debug(
          `registerSession skipped: ${filePath} holds a record from another origin`,
        );
        try {
          fields.onOriginConflict?.({ pid, filePath });
        } catch (error) {
          // A reporting callback must not turn a discovery miss into a
          // failed startup; registration is already best-effort.
          debugLogger.debug(`onOriginConflict threw: ${describe(error)}`);
        }
      };

      // Two passes at most. The first decides on what is there; if the
      // exclusive create then loses a race, the second re-reads whatever
      // won it and runs the winner through the same origin rule, exactly
      // as if it had been there before we looked.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Registration is the one write with nothing to merge into, so it
        // is also the one that would happily clobber a stranger. A record
        // from another origin at our PID number is not stale, it is not
        // ours, and it cannot be proven dead from here.
        const existing = await readRecord(filePath);
        if (
          existing !== null &&
          !isSameOrigin(existing.record, record.machineId, record.pidNamespace)
        ) {
          reportConflict();
          return false;
        }

        // `existing === null` covers two different situations and only one
        // of them is a free name: nothing is there, or something is there
        // that this code cannot honour (a planted symlink, a truncated
        // write, a future schema). Replacing the second is deliberate and
        // tested; claiming the first has to be exclusive.
        if (existing === null && !(await entryExists(filePath))) {
          // Claim the name with an operation the kernel makes exclusive,
          // rather than reading "absent" and renaming over whatever
          // arrived in between: two origins sharing `QWEN_HOME` and a PID
          // number would both see the gap, and the later rename would
          // silently replace the earlier live record.
          const outcome = await linkRecordExclusive(filePath, record);
          if (outcome === 'created') {
            retiredPids.delete(pid);
            return true;
          }
          // 'taken' — someone claimed it in between. Go round again and
          // route whatever they wrote through the origin rule above, as if
          // it had been there before we looked.
          if (outcome === 'taken') continue;
          // 'unsupported' — no hard links on this filesystem. Fall through
          // to the replacing write, which is where this path has always
          // been; the exclusivity gap is the price of the filesystem.
        }

        // Either a same-origin record is present — the recycled-PID
        // recovery path, where a predecessor died without unregistering —
        // or hard links are unavailable. Replace it, but commit only if
        // the directory entry is still the one that was validated.
        //
        // `noFollow` keeps a pre-planted `<pid>.json` symlink from
        // redirecting this write (and its forced 0600) to a file outside
        // the registry: the sandbox shares this directory across a trust
        // boundary, so the planting side is not hypothetical.
        await atomicWriteJSON(filePath, record, {
          mode: REGISTRY_FILE_MODE,
          forceMode: true,
          noFollow: true,
          assertCanCommit: existing
            ? () => assertSameEntry(filePath, existing.entry)
            : undefined,
        });
        retiredPids.delete(pid);
        return true;
      }

      debugLogger.debug(
        `registerSession skipped: lost the race for ${getSessionRecordPath(pid)} twice`,
      );
      return false;
    } catch (error) {
      debugLogger.debug(`registerSession failed: ${describe(error)}`);
      return false;
    }
  });
}

/** True when any directory entry exists at `filePath`, symlinks included. */
async function entryExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    // Anything other than "not there" — EACCES on the directory, say —
    // is not evidence of a free name, so do not treat it as one.
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

/**
 * Create `filePath` holding `record`, or report that someone else got
 * there first. Never replaces an existing entry of any kind.
 *
 * `link(2)` is the exclusivity primitive: it fails with `EEXIST` when the
 * new name exists — symlinks included, which are an entry rather than a
 * thing to follow — and it publishes a file that was already written and
 * fsynced, so the record is never observable half-formed. `rename(2)`,
 * the usual atomic-write commit, has the opposite property: it replaces.
 *
 * Returns `'unsupported'` where the filesystem has no hard links (some
 * network and FUSE mounts), leaving the caller on its previous path.
 */
async function linkRecordExclusive(
  filePath: string,
  record: SessionRegistryRecord,
): Promise<'created' | 'taken' | 'unsupported'> {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const handle = await fs.open(
      tmpPath,
      fsSync.constants.O_WRONLY |
        fsSync.constants.O_CREAT |
        fsSync.constants.O_EXCL,
      REGISTRY_FILE_MODE,
    );
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
      await handle.sync();
      // open()'s mode argument is masked by the umask; fchmod is not, and
      // goes through the handle so it cannot be redirected.
      await handle.chmod(REGISTRY_FILE_MODE);
    } finally {
      await handle.close();
    }

    try {
      await fs.link(tmpPath, filePath);
      return 'created';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') return 'taken';
      if (
        code === 'EPERM' ||
        code === 'ENOSYS' ||
        code === 'ENOTSUP' ||
        code === 'EOPNOTSUPP' ||
        code === 'EMLINK' ||
        code === 'EXDEV'
      ) {
        return 'unsupported';
      }
      throw error;
    }
  } finally {
    // The link, if it was made, keeps the inode alive under its real name.
    await fs.unlink(tmpPath).catch(() => {});
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
 * No-ops too when the record present at this PID came from another
 * origin — merging into it would rewrite a stranger's sessionId, cwd and
 * name, sending discovery to the wrong transcript — and once
 * {@link unregisterSession} has withdrawn this PID, since a patch landing
 * after the withdrawal would put a dead process back on the register.
 */
export async function patchSessionRecord(
  patch: Partial<Omit<SessionRegistryRecord, 'pid' | 'schemaVersion'>>,
  pid: number = process.pid,
): Promise<void> {
  await enqueueWrite(async () => {
    if (retiredPids.has(pid)) return;
    const filePath = getSessionRecordPath(pid);
    try {
      const existing = await readRecord(filePath);
      if (existing === null) return;
      if (
        !isSameOrigin(existing.record, readMachineId(), readPidNamespaceId())
      ) {
        return;
      }
      await atomicWriteJSON(
        filePath,
        { ...existing.record, ...patch },
        {
          mode: REGISTRY_FILE_MODE,
          forceMode: true,
          noFollow: true,
          assertCanCommit: () => assertSameEntry(filePath, existing.entry),
        },
      );
    } catch (error) {
      debugLogger.debug(`patchSessionRecord failed: ${describe(error)}`);
    }
  });
}

/**
 * Remove this process's record. Safe to call when none was written.
 *
 * Unlinks only what it can read back as its own: a record from another
 * origin at this PID number belongs to a session that is still running
 * somewhere, and one that will not re-register (registration is
 * startup-only). Anything unparseable is left too — it is not a record
 * this code wrote, so it is not this code's to delete.
 *
 * Also closes the register for this PID, so a `patchSessionRecord` queued
 * behind this call is dropped instead of writing the record back.
 */
export async function unregisterSession(
  pid: number = process.pid,
): Promise<void> {
  await enqueueWrite(async () => {
    // Before the unlink, not after: a patch queued behind this one must be
    // refused even if the unlink itself finds nothing to do.
    retiredPids.add(pid);
    const filePath = getSessionRecordPath(pid);
    try {
      const existing = await readRecord(filePath);
      if (existing === null || existing.record.pid !== pid) return;
      if (
        !isSameOrigin(existing.record, readMachineId(), readPidNamespaceId())
      ) {
        return;
      }
      // Node exposes no `unlinkat`-by-inode, so the entry is re-checked as
      // late as it can be. That narrows the swap window to the syscall
      // pair rather than to the whole validating read — the same binding
      // the write paths get from `assertCanCommit`, minus a primitive the
      // platform does not offer.
      assertSameEntry(filePath, existing.entry);
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      debugLogger.debug(`unregisterSession failed: ${describe(error)}`);
    }
  });
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
}

/**
 * Enumerate live sessions, newest first, sweeping records whose process
 * is provably gone.
 *
 * Returns an empty list rather than throwing when the registry directory
 * is missing or unreadable — "no peers" and "cannot look" are the same
 * outcome for every caller, and this sits on interactive paths.
 */
export async function listLiveSessions(
  options: ListLiveSessionsOptions = {},
): Promise<SessionRegistryRecord[]> {
  const {
    includeSelf = false,
    selfPid = process.pid,
    sweepStale = true,
  } = options;

  const dir = getSessionRegistryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      debugLogger.debug(`listLiveSessions readdir failed: ${describe(error)}`);
    }
    return [];
  }

  // Read once per enumeration, not once per record: a process cannot
  // change PID namespace or machine under itself, and both are syscalls.
  const selfNamespace = readPidNamespaceId();
  const selfMachine = readMachineId();
  const tokensAvailable = supportsProcStartToken();

  // Take the candidates before doing any work on them. Both how many
  // there are and what they are named is outside this process's control
  // (see MAX_RECORDS_PER_SCAN), so the ceiling has to be applied to the
  // list, not discovered while walking it.
  const candidates = entries.filter((name) => RECORD_FILENAME.test(name));
  if (candidates.length > MAX_RECORDS_PER_SCAN) {
    debugLogger.debug(
      `listLiveSessions: ${candidates.length} candidate records in ${dir}, examining ${MAX_RECORDS_PER_SCAN}`,
    );
    candidates.length = MAX_RECORDS_PER_SCAN;
  }

  const live: SessionRegistryRecord[] = [];
  await mapWithConcurrency(
    candidates,
    SCAN_CONCURRENCY,
    async (name: string) => {
      const filePath = path.join(dir, name);
      const read = await readRecord(filePath);
      if (read === null) return;
      const record = read.record;

      // A record whose filename disagrees with its contents was not
      // written by this code (or was renamed by hand). Skip it, and
      // never sweep it — we cannot reason about which PID it describes.
      if (`${record.pid}.json` !== name) return;

      // Every check below — the self-PID comparison included — reads
      // `record.pid` as a number on *our* machine in *our* PID
      // namespace. When the record came from another origin, or from a
      // writer whose origin we cannot pin down, that reading is
      // meaningless: the record is neither reported (the PID would name
      // some unrelated local process, up to and including this one) nor
      // swept (a local ESRCH says nothing about a process elsewhere,
      // and registration is startup-only, so an unlink here would hide
      // a live session for the rest of its life). This has to run
      // before the self-PID shortcut below, or a foreign record sitting
      // at our own PID number is adopted as our session without ever
      // reaching the gate.
      if (!isSameOrigin(record, selfMachine, selfNamespace)) return;

      if (record.pid === selfPid) {
        // Report the record at our own PID without probing: the origin
        // gate above has established it describes this machine and this
        // namespace, and the PID is ours, so it is alive by
        // construction. (It is not necessarily *this session's* record
        // — a same-origin predecessor that died on this PID leaves one
        // behind — but that is a liveness-of-content question, not one
        // this shortcut answers.)
        if (includeSelf) live.push(record);
        return;
      }

      if (isSameProcess(record.pid, record.procStart)) {
        // Alive — but on a platform that has start tokens, a record
        // without one was not written by this build, which always
        // records one. `isSameProcess` has just degraded to a bare
        // liveness check, so all this record proves is that *some*
        // process holds that PID; the session it describes —
        // sessionId, cwd, name — is whoever wrote the file's to choose,
        // and the origin fields needed to get this far are plaintext in
        // every sibling record. Withhold it from callers, but do not
        // sweep it: the PID is live, and it may equally be a future
        // version's record, which an unlink would erase for good.
        if (tokensAvailable && record.procStart == null) return;
        live.push(record);
        return;
      }

      if (sweepStale) {
        try {
          // Same binding as unregisterSession's: the entry that proved
          // itself stale is the only one this may remove, so a co-tenant
          // who swaps a live foreign record into the name after the read
          // does not get it deleted on their behalf.
          assertSameEntry(filePath, read.entry);
          await fs.unlink(filePath);
        } catch {
          // Raced with another session's sweep, replaced under us, or not
          // ours to delete.
        }
      }
    },
  );

  return live.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Read and validate one record. Returns null for anything unusable.
 *
 * Everything is read through a single handle opened `O_NOFOLLOW`, and the
 * entry's identity comes back with the bytes. Two reasons: the write paths
 * already refuse to follow a symlink planted at this name, so the read
 * that authorizes them must not follow one either; and every caller
 * mutates by *path* afterwards, which is only sound if it can check the
 * path still resolves to the inode that was validated (see
 * {@link assertSameEntry}).
 */
async function readRecord(filePath: string): Promise<ReadRecord | null> {
  let raw: string;
  let entry: EntryIdentity;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      filePath,
      fsSync.constants.O_RDONLY | noFollowFlag(),
    );
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    entry = { dev: stat.dev, ino: stat.ino };
    raw = await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
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
  const pidNamespace = value['pidNamespace'];
  const machineId = value['machineId'];
  const qwenVersion = value['qwenVersion'];
  const peerProtocol = value['peerProtocol'];

  return {
    entry,
    record: {
      schemaVersion,
      pid,
      procStart: typeof procStart === 'string' ? procStart : null,
      pidNamespace: typeof pidNamespace === 'string' ? pidNamespace : null,
      machineId: typeof machineId === 'string' ? machineId : null,
      sessionId,
      cwd,
      name,
      kind,
      startedAt,
      qwenVersion: typeof qwenVersion === 'string' ? qwenVersion : null,
      peerProtocol: typeof peerProtocol === 'number' ? peerProtocol : 0,
    },
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Deliberately not `Promise.all(items.map(...))`: `items` here is derived
 * from a directory a sandboxed co-tenant can write to, and that form
 * starts every read in the same tick.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
