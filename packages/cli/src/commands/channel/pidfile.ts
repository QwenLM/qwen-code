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
    info.procStart !== undefined &&
    info.procStart !== null &&
    typeof info.procStart !== 'string'
  ) {
    return null;
  }

  const workers = parseServiceInfoWorkers(info.workers);
  if (workers === null) return null;

  return {
    owner,
    pid: info.pid,
    ...(info.procStart !== undefined ? { procStart: info.procStart } : {}),
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

/**
 * Serialize all pidfile readers and writers. `proper-lockfile` uses an atomic
 * lock directory and recovers abandoned locks after their heartbeat is stale.
 */
function withPidFileLock<T>(operation: (filePath: string) => T): T {
  const filePath = pidFilePath();
  return withChannelPidfileLock(filePath, () => operation(filePath));
}

/** Check if a process is alive. */
function isProcessAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID file and return service info if the process is still alive.
 * Returns null if no file, invalid file, or stale (dead process).
 * Automatically cleans up stale PID files.
 */
export function readServiceInfo(): ServiceInfo | null {
  return withPidFileLock((filePath) => {
    if (!existsSync(filePath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      // Corrupt file — clean up while holding the shared pidfile lock.
      unlinkPidFile(filePath);
      return null;
    }

    const info = parseServiceInfo(parsed);
    if (!info) {
      // Invalid file — clean up before treating it as a running service.
      unlinkPidFile(filePath);
      return null;
    }

    if (!isSameProcess(info.pid, info.procStart)) {
      // Stale PID or recycled PID — clean up without signalling its new owner.
      unlinkPidFile(filePath);
      return null;
    }

    return info;
  });
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
export function writeServiceInfo(channels: string[]): void {
  const info: ServiceInfo = {
    owner: 'channel',
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    startedAt: new Date().toISOString(),
    channels,
  };

  withPidFileLock(() => writeInfo(info, 'wx'));
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
          buildInfo(new Date().toISOString(), readProcStartToken(servePid)),
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
      const info = buildInfo(
        existing.startedAt,
        existing.procStart ?? readProcStartToken(servePid),
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
    procStart: readProcStartToken(servePid),
    startedAt: new Date().toISOString(),
    channels,
    servePid,
  };

  withPidFileLock(() => writeInfo(info, 'wx'));
}

/** Delete the PID file. */
export function removeServiceInfo(expected?: ServiceInfo): void {
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
}

export function removeServeServiceInfo(
  servePid: number = process.pid,
): boolean {
  return withPidFileLock((filePath) => {
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
  });
}

/**
 * Send a signal to the running service.
 * Returns true if signal was sent, false if process not found.
 */
export function signalService(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  procStart?: string | null,
): boolean {
  if (!isValidPid(pid)) {
    return false;
  }

  if (procStart != null && !isSameProcess(pid, procStart)) return false;

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
  procStart?: string | null,
): Promise<boolean> {
  const isOriginalProcessAlive = () =>
    procStart == null ? isProcessAlive(pid) : isSameProcess(pid, procStart);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isOriginalProcessAlive()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isOriginalProcessAlive();
}
