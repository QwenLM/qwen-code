/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Connections made through `POST …/hosts/connect`, persisted.
 *
 * The credential of a joined Host already survives a restart; this record is
 * what says "reconnect on boot". It sits next to the credentials in
 * `~/.qwen/agent-hosts/connections.json` (0600), and holds no secret.
 * Several daemons on one machine share it, so writes are locked.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

export interface AgentHostConnectionRecord {
  serverUrl: string;
  workspaceId: string;
  workspaceCwd: string;
  allowHttp: boolean;
}

interface ConnectionsFile {
  schemaVersion: 1;
  connections: AgentHostConnectionRecord[];
}

export function agentHostConnectionsPath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'agent-hosts',
    'connections.json',
  );
}

function isRecord(value: unknown): value is AgentHostConnectionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['serverUrl'] === 'string' &&
    typeof entry['workspaceId'] === 'string' &&
    typeof entry['workspaceCwd'] === 'string' &&
    typeof entry['allowHttp'] === 'boolean'
  );
}

type ConnectionKey = Pick<
  AgentHostConnectionRecord,
  'serverUrl' | 'workspaceId' | 'workspaceCwd'
>;

function sameConnection(a: ConnectionKey, b: ConnectionKey): boolean {
  return (
    a.serverUrl === b.serverUrl &&
    a.workspaceId === b.workspaceId &&
    a.workspaceCwd === b.workspaceCwd
  );
}

/** The file's text, or undefined when there is none; any other failure throws. */
async function readConnectionsText(): Promise<string | undefined> {
  try {
    return await fs.readFile(agentHostConnectionsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The records in the file's text, or a throw when it is corrupt. */
function parseConnections(raw: string): AgentHostConnectionRecord[] {
  const parsed = (JSON.parse(raw) ?? {}) as Partial<ConnectionsFile>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.connections)) {
    throw new Error(`unexpected schema in ${agentHostConnectionsPath()}`);
  }
  return parsed.connections.filter(isRecord);
}

/**
 * Every saved connection, or a throw when the file cannot be trusted: a
 * missing file (ENOENT) is legitimately empty, but an unreadable one (a
 * transient `EMFILE`/`EIO`, a mode change) or a corrupt one is NOT "no
 * connections". A caller that must not mistake unreadable for absent — the
 * disconnect guard — reads through this and refuses on a throw.
 */
async function readAgentHostConnectionsStrict(): Promise<
  AgentHostConnectionRecord[]
> {
  const raw = await readConnectionsText();
  return raw === undefined ? [] : parseConnections(raw);
}

/** Every saved connection; an unreadable file reads as none (restore loop). */
export async function readAgentHostConnections(): Promise<
  AgentHostConnectionRecord[]
> {
  try {
    return await readAgentHostConnectionsStrict();
  } catch {
    writeStderrLine(
      `qwen serve: ignoring unreadable ${agentHostConnectionsPath()}.`,
    );
    return [];
  }
}

/** proper-lockfile's default, spelled out: every daemon must agree on it. */
const LOCK_STALE_MS = 10_000;

// How long a writer waits while another process holds the lock. It must
// outlast a lock left by a holder that died holding it (SIGKILL, OOM: no exit
// hook removes it), so a join's save takes that lock over instead of being
// reported unsaved, which a restart would make a lost connection. Writers
// here hold the lock only for one small write. A dead holder's lock goes
// stale `stale` after its last refresh, and up to about 1 s later when
// proper-lockfile stamped it ahead (a process's first lock, or a filesystem
// with 1 s mtime precision). 12 s leaves about 1 s of margin. (A holder that
// takes the lock after the wait began, and then dies, can still outlast it.)
const LOCK_WAIT_MS = 12_000;

// A writer that has held the lock this long was stalled (a paused VM, a hung
// disk) long enough that another may have taken it over as stale, and must
// not write. proper-lockfile only notices that on its next refresh, up to
// `stale / 2` later. 2 s short of `stale`, since a filesystem with 1 s mtime
// precision can date the lock up to 1 s early. A legitimate write that slow
// is refused too, as a retryable failure; these writes take milliseconds.
//
// What this cannot close: proper-lockfile's stale takeover (stat, rmdir,
// mkdir) is not atomic, and it cannot tell its own lock from one put in its
// place. So two daemons that take over the same dead lock at the same moment
// can both hold it, and a writer that stalled past `stale` removes whatever
// lock is there when it lets go, perhaps its successor's. It does not start
// a write once it knows, though.
const LOCK_HOLD_LIMIT_MS = LOCK_STALE_MS - 2_000;

// Writers in this process take turns ahead of the file lock. Two of them
// waiting behind the same dead lock would otherwise reach proper-lockfile's
// stale takeover together, and both could take it, one overwriting the
// other's record.
let writers: Promise<unknown> = Promise.resolve();

const lockBusy = () =>
  Object.assign(new Error('Lock file is already being held'), {
    code: 'ELOCKED',
  });

/**
 * Errors that mean the lock is changing hands rather than that it can never
 * be taken. ENOENT: the lock vanished under this attempt, as when two waiters
 * take over the same stale lock and one removes the other's fresh lock while
 * it checks it. On Windows, a directory being deleted answers EPERM or EBUSY
 * for a moment.
 */
function isTransient(code: string | undefined): boolean {
  return (
    code === 'ELOCKED' ||
    code === 'ENOENT' ||
    (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY'))
  );
}

interface ConnectionsLock {
  /** Throws once another writer may have taken the lock over. */
  assertHeld(): void;
  release(): Promise<void>;
}

/**
 * Takes the lock, waiting only while another process holds it (or it is
 * changing hands), until `deadline`. proper-lockfile's own `retries` would
 * retry every error, so a directory that can never be locked (read-only,
 * full) would also sit through the whole wait before failing.
 */
async function lockConnections(
  filePath: string,
  deadline: number,
): Promise<ConnectionsLock> {
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    let compromised: Error | undefined;
    // Counted from the attempt: the lock's mtime is set while it is taken.
    const attemptedAt = Date.now();
    try {
      const release = await lockfile.lock(filePath, {
        realpath: false,
        stale: LOCK_STALE_MS,
        // The default throws from a timer, which would take the daemon down.
        onCompromised: (error) => {
          compromised = error;
          writeStderrLine(
            `qwen serve: lost the lock on ${filePath}: ${error.message}`,
          );
        },
      });
      return {
        assertHeld: () => {
          if (compromised) throw compromised;
          if (Date.now() - attemptedAt >= LOCK_HOLD_LIMIT_MS) {
            throw Object.assign(
              new Error(
                `Held the lock on ${filePath} too long; another writer may have taken it over.`,
              ),
              { code: 'ECOMPROMISED' },
            );
          }
        },
        // proper-lockfile has already let go of a lock it reported lost.
        release: () => (compromised ? Promise.resolve() : release()),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Past the deadline, the error itself: ENOENT and Windows' EPERM can
      // also mean the lock can never be made (a parent that is not
      // writable, an ACL), and a disconnect must still read the file then.
      if (!isTransient(code) || Date.now() >= deadline) throw error;
      if (code === 'ENOENT') {
        // Or the directory went: no lock can be made without it.
        await fs
          .mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
          .catch(() => undefined);
      }
      // Jittered, so waiters in different daemons do not retry in step.
      const pause = wait * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

// How long past its deadline a writer still waits for its turn: the writer
// ahead may be making its own last attempt (up to 0.75 s after a deadline),
// and if that ends in time, this one gets one look at the lock after it.
const TURN_GRACE_MS = 1_500;

/**
 * Resolves once `previous` settles, or rejects as busy shortly after
 * `deadline`, so a writer stuck ahead (a hung disk) does not hold this one.
 */
function turnBefore(previous: Promise<unknown>, deadline: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(lockBusy()),
      Math.max(0, deadline + TURN_GRACE_MS - Date.now()),
    );
    void previous.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function updateConnections(
  mutate: (
    connections: AgentHostConnectionRecord[],
  ) => AgentHostConnectionRecord[],
): Promise<void> {
  // The wait counts from the call, not from this writer's turn: writers
  // queued behind one that waited out a held lock, or one stuck on a hung
  // disk, give up with it instead of each waiting again.
  const deadline = Date.now() + LOCK_WAIT_MS;
  const previous = writers;
  const turn = turnBefore(previous, deadline).then(() =>
    writeConnections(mutate, deadline),
  );
  // The next writer waits for this one, and for the one this one was queued
  // behind, in case this one gave up first. (Settled to nothing, so the chain
  // does not keep every earlier result.)
  writers = Promise.allSettled([previous, turn]).then(() => undefined);
  return turn;
}

/**
 * The records a write starts from. A file that cannot be read right now
 * (EMFILE, EIO) may still hold other connections, so the write fails rather
 * than replace them all, and so does one a newer version wrote. A corrupt
 * one holds nothing the restore loop would use, and is replaced.
 */
async function connectionsToUpdate(): Promise<AgentHostConnectionRecord[]> {
  const raw = await readConnectionsText();
  if (raw === undefined) return [];
  const version = schemaVersionOf(raw);
  if (typeof version === 'number' && version > 1) {
    throw Object.assign(
      new Error(
        `${agentHostConnectionsPath()} was written by a newer version of Qwen Code (schema ${version}); not replacing it.`,
      ),
      { code: 'ENEWERSCHEMA' },
    );
  }
  try {
    return parseConnections(raw);
  } catch {
    writeStderrLine(
      `qwen serve: replacing unreadable ${agentHostConnectionsPath()}.`,
    );
    return [];
  }
}

function schemaVersionOf(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { schemaVersion?: unknown } | null)
      ?.schemaVersion;
  } catch {
    return undefined;
  }
}

async function writeConnections(
  mutate: (
    connections: AgentHostConnectionRecord[],
  ) => AgentHostConnectionRecord[],
  deadline: number,
): Promise<void> {
  const filePath = agentHostConnectionsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lock = await lockConnections(filePath, deadline);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    const next: ConnectionsFile = {
      schemaVersion: 1,
      connections: mutate(await connectionsToUpdate()),
    };
    lock.assertHeld();
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    lock.assertHeld();
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

export async function saveAgentHostConnection(
  record: AgentHostConnectionRecord,
): Promise<void> {
  await updateConnections((connections) => [
    ...connections.filter((entry) => !sameConnection(entry, record)),
    record,
  ]);
}

/** Returns true when a record was removed. */
export async function removeAgentHostConnection(
  target: ConnectionKey,
): Promise<boolean> {
  let removed = false;
  await updateConnections((connections) => {
    const kept = connections.filter((entry) => !sameConnection(entry, target));
    removed = kept.length !== connections.length;
    return kept;
  });
  return removed;
}

/**
 * The saved record for this connection, as the restore loop would find it:
 * read the same way, without the lock, so an unreadable file has none.
 */
export async function findAgentHostConnection(
  target: ConnectionKey,
): Promise<AgentHostConnectionRecord | undefined> {
  return (await readAgentHostConnections()).find((entry) =>
    sameConnection(entry, target),
  );
}

/**
 * A lookup that tells "no record" apart from "could not read": the disconnect
 * guard may only stop a connection it can confirm is forgotten, and an
 * unreadable file is not an absent record — the restore loop would reconnect.
 */
export type AgentHostConnectionLookup =
  | { kind: 'found'; record: AgentHostConnectionRecord }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

export async function findAgentHostConnectionChecked(
  target: ConnectionKey,
): Promise<AgentHostConnectionLookup> {
  let connections: AgentHostConnectionRecord[];
  try {
    connections = await readAgentHostConnectionsStrict();
  } catch {
    return { kind: 'unreadable' };
  }
  const record = connections.find((entry) => sameConnection(entry, target));
  return record ? { kind: 'found', record } : { kind: 'absent' };
}

const RESTORE_RETRY_MS = 30_000;
/** How often a restored connection checks that it is still up. */
const RESTORE_WATCH_MS = 5_000;

export interface AgentHostRestoreRuntime {
  bridge: AcpSessionBridge;
  workspaceCwd: string;
  generationGuard?: WorkspaceGenerationGuard;
}

export interface AgentHostRestoreOptions {
  /**
   * The trusted, active runtime serving `workspaceCwd` right now, or
   * undefined (not registered, not trusted, or between generations).
   */
  runtimeFor(workspaceCwd: string): AgentHostRestoreRuntime | undefined;
  /** Stops every restore loop. */
  signal?: AbortSignal;
  retryMs?: number;
  watchMs?: number;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return delay(ms, undefined, { ref: false, signal }).catch(() => undefined);
}

/**
 * Keeps every saved connection up, for every workspace this daemon serves,
 * in the background. Each record waits until its workspace has a trusted
 * active runtime (a workspace registered or trusted later is picked up on
 * the next check, every 5 s), connects, and connects again when that
 * runtime is replaced or the connection stops. A coordinator that is down is
 * retried every 30 s. A record whose credential is gone (revoked) is pruned; a
 * record that was removed (`DELETE hosts/connect`) is let go. Never throws.
 */
export async function restoreAgentHostConnections(
  options: AgentHostRestoreOptions,
): Promise<void> {
  const {
    hasAgentHostCredential,
    isAgentHostConnectionRunning,
    startAgentHostConnection,
  } = await import('./agent-host-client.js');
  const retryMs = options.retryMs ?? RESTORE_RETRY_MS;
  const watchMs = options.watchMs ?? RESTORE_WATCH_MS;
  const { signal } = options;
  const keep = async (saved: AgentHostConnectionRecord) => {
    while (!signal?.aborted) {
      const record = await findAgentHostConnection(saved);
      if (!record || signal?.aborted) return;
      const runtime = options.runtimeFor(record.workspaceCwd);
      if (runtime && !runtime.generationGuard?.closed) {
        const credential = await hasAgentHostCredential(record);
        if (signal?.aborted) return;
        if (credential === undefined) {
          // Unreadable is not revoked: keep the record and try again later.
          writeStderrLine(
            `qwen serve: could not read the Agent Host credential for ${record.serverUrl}; retrying.`,
          );
          await pause(retryMs, signal);
          continue;
        }
        if (!credential) {
          await removeAgentHostConnection(record).catch(() => undefined);
          writeStderrLine(
            `qwen serve: dropped the saved Agent Host connection to ${record.serverUrl} (no credential).`,
          );
          return;
        }
        try {
          await startAgentHostConnection({
            ...record,
            bridge: runtime.bridge,
            workspaceCwd: runtime.workspaceCwd,
            ...(runtime.generationGuard
              ? { generationGuard: runtime.generationGuard }
              : {}),
          });
          if (signal?.aborted) return;
          // Up. Watch it: a replaced runtime (trust change, re-registration)
          // closes this generation, and the connection stops with it.
          while (
            !signal?.aborted &&
            !runtime.generationGuard?.closed &&
            isAgentHostConnectionRunning(record)
          ) {
            await pause(watchMs, signal);
          }
        } catch (error) {
          writeStderrLine(
            `qwen serve: could not reconnect to ${record.serverUrl}; retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
          await pause(retryMs, signal);
          continue;
        }
      }
      // No usable runtime yet, or the connection just stopped: look again
      // soon, never in a tight loop.
      await pause(watchMs, signal);
    }
  };
  // One loop per saved connection. The file is read again every watch tick,
  // so a record saved after boot (`qwen agents join` against this running
  // daemon) is supervised too, instead of only on the next restart.
  const supervised = new Set<string>();
  const supervise = (record: AgentHostConnectionRecord) => {
    const key = `${record.serverUrl}\0${record.workspaceId}\0${record.workspaceCwd}`;
    if (supervised.has(key)) return;
    supervised.add(key);
    void keep(record)
      .catch((error: unknown) =>
        writeStderrLine(
          `qwen serve: stopped restoring the Agent Host connection to ${record.serverUrl}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => supervised.delete(key));
  };
  for (const record of await readAgentHostConnections()) supervise(record);
  void (async () => {
    while (!signal?.aborted) {
      await pause(watchMs, signal);
      if (signal?.aborted) return;
      const records = await readAgentHostConnections().catch(
        (): AgentHostConnectionRecord[] => [],
      );
      for (const record of records) supervise(record);
    }
  })();
}
