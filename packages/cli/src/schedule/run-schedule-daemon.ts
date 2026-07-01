/**
 * Daemon process entry point for `qwen schedule daemon start`.
 *
 * Long-lived foreground process: instantiates ScheduleDaemon, owns the
 * CronScheduler tick, spawns `qwen -p` children on each fire.
 *
 * PID file: ~/.qwen/schedule-daemon.pid
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

import {
  ScheduleDaemon,
} from '@qwen-code/qwen-code-core';

// ---------------------------------------------------------------------------
// PID file
// ---------------------------------------------------------------------------

function getPidFilePath(): string {
  return path.join(homedir(), '.qwen', 'schedule-daemon.pid');
}

function writePidFile(): void {
  const dir = path.dirname(getPidFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getPidFilePath(), String(process.pid), 'utf-8');
}

function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(getPidFilePath(), 'utf-8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(getPidFilePath());
  } catch {
    // best-effort
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// runScheduleDaemon — foreground entry for `qwen schedule daemon start`
// ---------------------------------------------------------------------------

let activeDaemon: ScheduleDaemon | null = null;

export async function runScheduleDaemon(): Promise<never> {
  // Prevent concurrent daemons
  const existingPid = readPidFile();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new Error(
      `Schedule daemon is already running (PID ${existingPid}). ` +
        `Use 'qwen schedule daemon stop' first, or 'qwen schedule daemon status'.`,
    );
  }

  writePidFile();

  const daemon = new ScheduleDaemon();
  activeDaemon = daemon;

  // Graceful shutdown on signals
  const shutdown = async (signal: string) => {
    process.stderr.write(`\nqwen schedule daemon: received ${signal}, shutting down...\n`);
    await daemon.stop();
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Clean up PID file on unexpected exit
  process.on('exit', () => {
    if (activeDaemon) {
      removePidFile();
    }
  });

  process.stderr.write('qwen schedule daemon: starting...\n');

  try {
    await daemon.start();
    process.stderr.write(
      `qwen schedule daemon: running with ${daemon.getStatus().taskCount} task(s)\n`,
    );
  } catch (err) {
    removePidFile();
    throw err;
  }

  // Block forever — the scheduler tick keeps the process alive.
  // (CronScheduler.start's setInterval is deliberately not unref'd)
  return new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// stopScheduleDaemon — SIGTERM the PID from the PID file
// ---------------------------------------------------------------------------

export async function stopScheduleDaemon(): Promise<boolean> {
  const pid = readPidFile();
  if (pid === null || !isProcessAlive(pid)) {
    return false;
  }
  // SIGTERM triggers the shutdown handler in the daemon process above
  process.kill(pid, 'SIGTERM');
  // Wait up to 5s for the process to exit
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}

// ---------------------------------------------------------------------------
// getScheduleDaemonStatus — probe the PID file
// ---------------------------------------------------------------------------

export async function getScheduleDaemonStatus(): Promise<{
  running: boolean;
  pid: number | null;
  taskCount: number;
  activeFires: Array<{ taskId: string; startedAt: string }>;
}> {
  const pid = readPidFile();
  if (pid === null || !isProcessAlive(pid)) {
    return { running: false, pid: null, taskCount: 0, activeFires: [] };
  }
  // Can't introspect the remote daemon's internal state from another
  // process — just report that it's alive.
  return { running: true, pid, taskCount: -1, activeFires: [] };
}
