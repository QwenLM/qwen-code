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
import { Storage } from '@qwen-code/qwen-code-core';

export interface ServiceInfoWorker {
  workspaceId?: string;
  workspaceCwd?: string;
  channels: string[];
  workerPid?: number;
}

export interface ServiceInfo {
  owner: 'channel' | 'serve';
  pid: number;
  startedAt: string;
  channels: string[];
  /**
   * Workspace the standalone service was started from. Channel state is
   * scoped per workspace (#8975), so `qwen channel stop` needs it to record
   * stops in the right state file. Absent for pidfiles written by older
   * releases.
   */
  workspaceCwd?: string;
  servePid?: number;
  workerPid?: number;
  /**
   * Per-workspace channel workers for a multi-workspace `qwen serve`. Additive
   * to the single-worker `channels` / `workerPid` fields, which stay populated
   * (union of channels; primary worker pid) for older readers.
   */
  workers?: ServiceInfoWorker[];
}

function pidFilePath(): string {
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
    info.workspaceCwd !== undefined &&
    (typeof info.workspaceCwd !== 'string' || info.workspaceCwd.length === 0)
  ) {
    return null;
  }

  const workers = parseServiceInfoWorkers(info.workers);
  if (workers === null) return null;

  return {
    owner,
    pid: info.pid,
    startedAt: info.startedAt,
    channels: info.channels,
    ...(info.workspaceCwd !== undefined
      ? { workspaceCwd: info.workspaceCwd }
      : {}),
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

/**
 * True only when the process is CONFIRMED dead. `kill(pid, 0)` throwing
 * EPERM means the process EXISTS but belongs to another user — it is
 * alive; treating EPERM as dead made `readServiceInfo` report a live
 * shared-HOME service as crashed, and the stop crash-path then recorded
 * its RUNNING channels as stopped (#8975). Only ESRCH proves death; an
 * invalid pid counts as dead (there is nothing to preserve).
 */
function isProcessDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Check if a process is alive (EPERM = alive, see `isProcessDead`). */
function isProcessAlive(pid: number): boolean {
  return !isProcessDead(pid);
}

/**
 * Access classification for a stop probe: alive-and-signalable, alive
 * under ANOTHER user (EPERM), or confirmed dead (ESRCH / invalid pid).
 * A bare signalable boolean collapses ESRCH and EPERM into one `false`:
 * a service crashing in the window between the pidfile liveness check
 * and signal delivery would be misdiagnosed as "running under a
 * different user" — exit 1 with the wrong message, no crash-path stop
 * record, and the stale pidfile left behind (#8975, R14).
 */
export function classifyProcessAccess(
  pid: number,
): 'signalable' | 'other-user' | 'dead' {
  if (!isValidPid(pid)) {
    return 'dead';
  }

  try {
    process.kill(pid, 0);
    return 'signalable';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
      ? 'other-user'
      : 'dead';
  }
}

/**
 * Read and parse the PID file WITHOUT the liveness check and WITHOUT
 * unlinking it. Lets a caller capture a stale (crashed) service's channel
 * list before `readServiceInfo` discards the file — a stop issued right
 * after a crash must still record those channels as stopped (#8975).
 * Returns null if the file is missing or unparseable.
 */
export function peekServiceInfo(): ServiceInfo | null {
  const filePath = pidFilePath();
  if (!existsSync(filePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  return parseServiceInfo(parsed);
}

/**
 * Read the PID file and return service info if the process is still alive.
 * Returns null if no file, invalid file, or stale (dead process).
 * Automatically cleans up stale PID files.
 */
export function readServiceInfo(): ServiceInfo | null {
  const filePath = pidFilePath();
  if (!existsSync(filePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    // Corrupt file — clean up
    unlinkPidFile(filePath);
    return null;
  }

  const info = parseServiceInfo(parsed);
  if (!info) {
    // Invalid file — clean up before treating it as a running service.
    unlinkPidFile(filePath);
    return null;
  }

  if (!isProcessAlive(info.pid)) {
    // Stale PID — process is confirmed dead (ESRCH), clean up. An EPERM
    // pid is ALIVE under another user: keep the file and report the
    // service as running (#8975).
    unlinkPidFile(filePath);
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

/** Write PID file with current standalone channel process info. */
export function writeServiceInfo(
  channels: string[],
  workspaceCwd?: string,
): void {
  const info: ServiceInfo = {
    owner: 'channel',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    channels,
    ...(workspaceCwd !== undefined ? { workspaceCwd } : {}),
  };

  try {
    writeInfo(info, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // An existing pidfile may be STALE: SIGKILL/OOM and any
    // `process.exit()` past the SIGINT/SIGTERM handlers (a crash path,
    // a concurrent fatal error) bypass the shutdown that removes it,
    // leaving a dangling reservation behind. `readServiceInfo` carries
    // the liveness-aware cleanup, but it runs at the TOP of the start
    // flow — a service that dies during this start's connect window
    // recreates the shape here, and the exclusive-create failure alone
    // cannot tell a live concurrent service from a dead one's leftover.
    // Verify the recorded pid before refusing; clean up and retry once
    // when it is dead, mirroring the serve-side reservation flow
    // (run-qwen-serve's reserveChannelServicePidfile) (doudouOUC C1).
    const existing = peekServiceInfo();
    if (existing !== null && isProcessAlive(existing.pid)) throw error;
    unlinkPidFile(pidFilePath());
    // A live start racing the cleanup legitimately re-creates the file
    // in between — this retry then throws EEXIST like the first attempt.
    writeInfo(info, 'wx');
  }
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
  const buildInfo = (startedAt: string): ServiceInfo => ({
    owner: 'serve',
    pid: servePid,
    startedAt,
    channels,
    servePid,
    ...(workerPid !== undefined ? { workerPid } : {}),
    ...(workers !== undefined ? { workers } : {}),
  });

  const filePath = pidFilePath();
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      writeInfo(buildInfo(new Date().toISOString()), 'wx');
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
    if (
      !existing ||
      existing.owner !== 'serve' ||
      existing.pid !== servePid ||
      existing.servePid !== servePid
    ) {
      throw fileExistsError(
        'Channel service pidfile is owned by another process.',
      );
    }
    const info = buildInfo(existing.startedAt);
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify(info, null, 2), 0, 'utf-8');
  } finally {
    closeSync(fd);
  }
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
    startedAt: new Date().toISOString(),
    channels,
    servePid,
  };

  writeInfo(info, 'wx');
}

/** Delete the PID file. */
export function removeServiceInfo(): void {
  const filePath = pidFilePath();
  if (existsSync(filePath)) {
    unlinkPidFile(filePath);
  }
}

export function removeServeServiceInfo(
  servePid: number = process.pid,
): boolean {
  const filePath = pidFilePath();
  if (!existsSync(filePath)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }

  const info = parseServiceInfo(parsed);
  if (
    !info ||
    info.owner !== 'serve' ||
    info.servePid !== servePid ||
    info.pid !== servePid
  ) {
    return false;
  }

  return unlinkPidFile(filePath);
}

/**
 * Send a signal to the running service.
 * Returns true if signal was sent, false if process not found.
 */
export function signalService(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  if (!isValidPid(pid)) {
    return false;
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
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
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isProcessAlive(pid);
}
