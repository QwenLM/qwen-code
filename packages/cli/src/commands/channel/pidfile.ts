import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  constants,
  ftruncateSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';
import {
  isSameProcess,
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
  Storage,
} from '@qwen-code/qwen-code-core';
import { withChannelPidfileLock } from './pidfile-lock.js';

export interface ServiceInfoWorker {
  workspaceId?: string;
  workspaceCwd?: string;
  channels: string[];
  workerPid?: number;
}

export interface ServiceInfo {
  owner: 'channel' | 'serve';
  pid: number;
  /** Start-time token guarding against PID reuse; absent in legacy files. */
  procStart?: string | null;
  /**
   * PID-namespace inode of the writer. One `~/.qwen` can be shared across
   * namespaces and machines, where a PID number resolves to a different
   * process, so a reader needs this to recognise a record that is not its
   * own; absent in legacy files.
   */
  pidNs?: number | null;
  startedAt: string;
  channels: string[];
  servePid?: number;
  workerPid?: number;
  /**
   * Per-workspace channel workers for a multi-workspace `qwen serve`. Additive
   * to the single-worker `channels` / `workerPid` fields, which stay populated
   * (union of channels; primary worker pid) for older readers.
   */
  workers?: ServiceInfoWorker[];
}

export function pidFilePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'channels', 'service.pid');
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
}

function parseServiceInfo(value: unknown): ServiceInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const info = value as Partial<ServiceInfo>;
  const owner = info.owner ?? 'channel';
  if (owner !== 'channel' && owner !== 'serve') return null;
  if (
    !isValidPid(info.pid) ||
    typeof info.startedAt !== 'string' ||
    Number.isNaN(Date.parse(info.startedAt)) ||
    !Array.isArray(info.channels) ||
    !info.channels.every((channel) => typeof channel === 'string')
  ) {
    return null;
  }
  if (info.servePid !== undefined && !isValidPid(info.servePid)) return null;
  if (info.workerPid !== undefined && !isValidPid(info.workerPid)) return null;
  if (
    info.procStart !== undefined &&
    info.procStart !== null &&
    typeof info.procStart !== 'string'
  ) {
    return null;
  }
  if (
    info.pidNs !== undefined &&
    info.pidNs !== null &&
    typeof info.pidNs !== 'number'
  ) {
    return null;
  }

  const workers = parseServiceInfoWorkers(info.workers);
  if (workers === null) return null;

  return {
    owner,
    pid: info.pid,
    ...(info.procStart !== undefined ? { procStart: info.procStart } : {}),
    ...(info.pidNs !== undefined ? { pidNs: info.pidNs } : {}),
    startedAt: info.startedAt,
    channels: info.channels,
    ...(info.servePid !== undefined ? { servePid: info.servePid } : {}),
    ...(info.workerPid !== undefined ? { workerPid: info.workerPid } : {}),
    ...(workers !== undefined ? { workers } : {}),
  };
}

/**
 * Validate the additive `workers[]` list. Returns `undefined` when absent,
 * `null` when malformed (rejects the whole pidfile), or the parsed list.
 */
function parseServiceInfoWorkers(
  value: unknown,
): ServiceInfoWorker[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const workers: ServiceInfoWorker[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }
    const worker = raw as Partial<ServiceInfoWorker>;
    if (
      !Array.isArray(worker.channels) ||
      !worker.channels.every((channel) => typeof channel === 'string')
    ) {
      return null;
    }
    if (
      worker.workspaceId !== undefined &&
      typeof worker.workspaceId !== 'string'
    ) {
      return null;
    }
    if (
      worker.workspaceCwd !== undefined &&
      typeof worker.workspaceCwd !== 'string'
    ) {
      return null;
    }
    if (worker.workerPid !== undefined && !isValidPid(worker.workerPid)) {
      return null;
    }
    workers.push({
      channels: worker.channels,
      ...(worker.workspaceId !== undefined
        ? { workspaceId: worker.workspaceId }
        : {}),
      ...(worker.workspaceCwd !== undefined
        ? { workspaceCwd: worker.workspaceCwd }
        : {}),
      ...(worker.workerPid !== undefined
        ? { workerPid: worker.workerPid }
        : {}),
    });
  }
  return workers;
}

function unlinkPidFile(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The boot-id prefix of a `<boot_id>:<starttime>` token, or null. */
function bootIdOf(procStart: string | null | undefined): string | null {
  if (procStart == null) return null;
  const separator = procStart.indexOf(':');
  return separator === -1 ? null : procStart.slice(0, separator);
}

/**
 * True when this machine and PID namespace could have written `info`. A record
 * from another boot or namespace describes PIDs that resolve to different
 * processes here, so whatever a local probe says about that number proves
 * nothing about the writer; an identity this side cannot read is likewise no
 * evidence, and a legacy record carries none at all.
 */
function isLocalIdentity(info: ServiceInfo): boolean {
  if (info.pidNs !== undefined && info.pidNs !== readPidNamespaceId()) {
    return false;
  }
  const recordBootId = bootIdOf(info.procStart);
  return recordBootId === null || recordBootId === readLocalBootId();
}

/**
 * True when `info` is the serve reservation `servePid` made from this side.
 * Another boot, machine, or PID namespace sharing this home can hold the same
 * PID number, so the number alone does not authorize replacing or deleting the
 * record. The recorded token is deliberately not compared: the update path
 * carries a reservation's token forward, and a legacy record has none.
 */
function isOwnServeReservation(
  info: ServiceInfo | null,
  servePid: number,
): info is ServiceInfo {
  return (
    info !== null &&
    info.owner === 'serve' &&
    info.pid === servePid &&
    info.servePid === servePid &&
    isLocalIdentity(info)
  );
}

/**
 * Serialize all pidfile readers and writers. `proper-lockfile` uses an atomic
 * lock directory and recovers abandoned locks after their acquisition is stale.
 */
function withPidFileLock<T>(operation: (filePath: string) => T): T {
  const filePath = pidFilePath();
  return withChannelPidfileLock(filePath, () => operation(filePath));
}

/**
 * Read the PID file and return service info if the process is still alive.
 * Returns null if no file, invalid file, stale (dead process), or a record
 * another boot, machine, or PID namespace wrote.
 * Automatically cleans up stale PID files.
 */
export function readServiceInfo(): ServiceInfo | null {
  const filePath = pidFilePath();
  // Taking the lock creates the channels directory, so it costs write access
  // a diagnostic read must not require: skip it when there is nothing to
  // read, and degrade when it cannot be taken (a read-only or shared home).
  if (!existsSync(filePath)) return null;
  try {
    return withChannelPidfileLock(filePath, () =>
      readServiceInfoRecord(filePath, true),
    );
  } catch {
    // The unlocked fallback never sweeps: unlinking without the lock would
    // race a concurrent writer on the paths the lock serializes.
    return readServiceInfoRecord(filePath, false);
  }
}

function readServiceInfoRecord(
  filePath: string,
  sweep: boolean,
): ServiceInfo | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    // An unreadable file is not a corrupt one: its bytes were never seen,
    // so leave the record for a side that can read it.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file — clean up while holding the shared pidfile lock.
    if (sweep) unlinkPidFile(filePath);
    return null;
  }

  const info = parseServiceInfo(parsed);
  if (!info) {
    // Invalid file — clean up before treating it as a running service.
    if (sweep) unlinkPidFile(filePath);
    return null;
  }

  if (!isLocalIdentity(info)) {
    // Another boot, machine, or PID namespace wrote this record: a local
    // probe of its PID proves nothing about the writer — the number can be
    // free here and alive there, or alive here and owned by an unrelated
    // process. Leave it for a reader on its own side.
    return null;
  }

  if (!isSameProcess(info.pid, info.procStart)) {
    // Stale PID or recycled PID — clean up without signalling its new owner.
    if (sweep) unlinkPidFile(filePath);
    return null;
  }

  return info;
}

function writeInfo(info: ServiceInfo, flag: 'w' | 'wx' = 'w'): void {
  const filePath = pidFilePath();
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(info, null, 2), {
    encoding: 'utf-8',
    flag,
  });
}

function fileExistsError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'EEXIST';
  return err;
}

/**
 * Exclusive creates meet a record the caller's own earlier read did not: seconds
 * of startup pass between the two, so a record that was live then can be dead
 * now. Re-run the read path's sweep decision under the lock this call already
 * holds, once — only a live record, or one this side can never verify, blocks
 * the write. The latter was written before a reboot, or by another machine or
 * PID namespace sharing this home; it is kept on purpose, no retry clears it,
 * so name the file instead of letting callers report a concurrent startup.
 */
function writeInfoExclusive(info: ServiceInfo): void {
  const filePath = pidFilePath();
  try {
    writeInfo(info, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    let existing: ServiceInfo | null = null;
    try {
      existing = parseServiceInfo(JSON.parse(readFileSync(filePath, 'utf-8')));
    } catch {
      throw err;
    }

    if (existing && !isLocalIdentity(existing)) {
      // The code serve's channel routes already answer with a 409 carrying this
      // message; an unmapped one would be replaced by a generic failure.
      const conflict = new Error(
        `Channel service pidfile ${filePath} holds a record this machine cannot verify, written before a reboot or by another machine or PID namespace sharing this home. Confirm no channel service is running, then delete that file to start again.`,
      ) as NodeJS.ErrnoException;
      conflict.code = 'channel_service_conflict';
      throw conflict;
    }

    if (existing && isSameProcess(existing.pid, existing.procStart)) {
      throw err; // A live record this side wrote: a genuine concurrent startup.
    }

    // A dead or invalid local record is transient: sweep it and retry the
    // exclusive create once, still under the lock this call already holds.
    unlinkPidFile(filePath);
    writeInfo(info, 'wx');
  }
}

function readPidfileProcessToken(pid: number): string | null {
  let procStart = readProcStartToken(pid);
  if (process.platform !== 'linux' || procStart !== null) return procStart;

  // Linux token reads can fail transiently under file-descriptor pressure.
  procStart = readProcStartToken(pid);
  if (procStart !== null) return procStart;

  throw new Error(
    `Unable to read the process start token for PID ${pid}; refusing to write an impersonable Channel pidfile.`,
  );
}

function readPidfileNamespaceId(): number | null {
  let pidNs = readPidNamespaceId();
  if (process.platform !== 'linux' || pidNs !== null) return pidNs;

  // Retried and refused exactly like the token above: `isLocalIdentity` never
  // resolves a namespace-less Linux record, so writing one leaves litter no
  // reader can sweep and not even its own writer can remove.
  pidNs = readPidNamespaceId();
  if (pidNs !== null) return pidNs;

  throw new Error(
    'Unable to read the PID namespace id; refusing to write an unreclaimable Channel pidfile.',
  );
}

/** Write PID file with current standalone channel process info. */
export function writeServiceInfo(channels: string[]): void {
  const info: ServiceInfo = {
    owner: 'channel',
    pid: process.pid,
    procStart: readPidfileProcessToken(process.pid),
    pidNs: readPidfileNamespaceId(),
    startedAt: new Date().toISOString(),
    channels,
  };

  withPidFileLock(() => writeInfoExclusive(info));
}

export function writeServeServiceInfo({
  channels,
  servePid = process.pid,
  workerPid,
  workers,
}: {
  channels: string[];
  servePid?: number;
  workerPid?: number;
  workers?: ServiceInfoWorker[];
}): void {
  const buildInfo = (
    startedAt: string,
    procStart: string | null,
  ): ServiceInfo => ({
    owner: 'serve',
    pid: servePid,
    procStart,
    pidNs: readPidfileNamespaceId(),
    startedAt,
    channels,
    servePid,
    ...(workerPid !== undefined ? { workerPid } : {}),
    ...(workers !== undefined ? { workers } : {}),
  });

  withPidFileLock((filePath) => {
    let fd: number;
    try {
      fd = openSync(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        writeInfo(
          buildInfo(
            new Date().toISOString(),
            readPidfileProcessToken(servePid),
          ),
          'wx',
        );
        return;
      }
      throw err;
    }

    try {
      let existing: ServiceInfo | null = null;
      try {
        existing = parseServiceInfo(JSON.parse(readFileSync(fd, 'utf-8')));
      } catch {
        // Treat corrupt data as owned by another process. This updater must only
        // replace the serve reservation it created earlier in startup.
      }
      if (!isOwnServeReservation(existing, servePid)) {
        throw fileExistsError(
          'Channel service pidfile is owned by another process.',
        );
      }
      const info = buildInfo(
        existing.startedAt,
        existing.procStart ?? readPidfileProcessToken(servePid),
      );
      ftruncateSync(fd, 0);
      writeSync(fd, JSON.stringify(info, null, 2), 0, 'utf-8');
    } finally {
      closeSync(fd);
    }
  });
}

export function reserveServeServiceInfo({
  channels,
  servePid = process.pid,
}: {
  channels: string[];
  servePid?: number;
}): void {
  const info: ServiceInfo = {
    owner: 'serve',
    pid: servePid,
    procStart: readPidfileProcessToken(servePid),
    pidNs: readPidfileNamespaceId(),
    startedAt: new Date().toISOString(),
    channels,
    servePid,
  };

  withPidFileLock(() => writeInfoExclusive(info));
}

/** Delete the PID file. */
export function removeServiceInfo(expected?: ServiceInfo): void {
  try {
    withPidFileLock((filePath) => {
      if (!expected) {
        if (existsSync(filePath)) unlinkPidFile(filePath);
        return;
      }

      try {
        const current = parseServiceInfo(
          JSON.parse(readFileSync(filePath, 'utf-8')),
        );
        if (
          current?.owner === expected.owner &&
          current.pid === expected.pid &&
          current.procStart === expected.procStart &&
          current.startedAt === expected.startedAt
        ) {
          unlinkPidFile(filePath);
        }
      } catch {
        // The original service already removed its pidfile.
      }
    });
  } catch {
    // Fire-and-forget cleanup must not abort its caller's exit path; a record
    // left behind is swept on the next read that can take the lock.
  }
}

export function removeServeServiceInfo(
  servePid: number = process.pid,
): boolean {
  try {
    return withPidFileLock((filePath) => {
      if (!existsSync(filePath)) return false;

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return false;
      }

      if (!isOwnServeReservation(parseServiceInfo(parsed), servePid)) {
        return false;
      }

      return unlinkPidFile(filePath);
    });
  } catch {
    return false;
  }
}

export type SignalServiceOutcome = 'sent' | 'refused' | 'not-permitted';

/**
 * Send a signal to the running service.
 * Returns 'sent' if the signal was delivered, 'not-permitted' if the OS
 * refused it for lack of permission (a live process owned by another user),
 * or 'refused' if the process is gone or its recorded start token could not
 * be confirmed.
 */
export function signalService(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  procStart?: string | null,
): SignalServiceOutcome {
  if (!isValidPid(pid)) {
    return 'refused';
  }

  if (procStart != null) {
    // An unreadable token and a recycled PID both compare unequal, and the
    // caller treats a refusal as licence to drop the record: retry once, as
    // the write path does, before concluding the PID belongs to someone else.
    const current = readProcStartToken(pid) ?? readProcStartToken(pid);
    if (current !== procStart) return 'refused';
  }

  try {
    process.kill(pid, signal);
    return 'sent';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
      ? 'not-permitted'
      : 'refused';
  }
}

/**
 * Wait for a process to exit, polling at intervals.
 * Returns true if process exited, false if timeout.
 */
export async function waitForExit(
  pid: number,
  timeoutMs: number = 5000,
  pollMs: number = 200,
  procStart?: string | null,
): Promise<boolean> {
  const isOriginalProcessAlive = () => isSameProcess(pid, procStart);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isOriginalProcessAlive()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isOriginalProcessAlive();
}
