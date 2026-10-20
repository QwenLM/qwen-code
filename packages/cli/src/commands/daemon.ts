/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import {
  currentPidNamespace,
  isProcessAlive,
  readDaemonDiscoveries,
  removeDaemonDiscovery,
  resolveDaemonDiscoveryDir,
  type DaemonDiscoveryEntry,
  type DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';
import {
  ignoreBrokenPipe,
  writeStderrLine,
  writeStdoutLine,
} from '../utils/stdioHelpers.js';
import { sanitizeTerminalText } from '../ui/utils/textUtils.js';

const HEALTH_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 100;
const FOLLOW_POLL_MS = 250;
const PROCESS_START_TOLERANCE_MS = 5_000;
const PROCESS_START_LEAD_MS = 10 * 60_000;

type DaemonHealth = 'running' | 'unreachable' | 'stale';

interface DaemonStatusRow {
  entry: DaemonDiscoveryEntry;
  health: DaemonHealth;
}

interface StatusArgs {
  json?: boolean;
  prune?: boolean;
}

interface LogsArgs {
  port?: number;
  follow?: boolean;
  lines?: number;
}

interface StopArgs {
  port?: number;
  all?: boolean;
  force?: boolean;
}

function age(iso: string, now = Date.now()): number {
  const started = Date.parse(iso);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/**
 * The recorded daemon's process start time: ps's lstart on POSIX, and
 * Get-Process StartTime through PowerShell on Windows. undefined means the
 * start time cannot be established, and callers refuse rather than signal.
 */
export function processStartTime(pid: number): number | undefined {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return undefined;
    }
    const parsed = Date.parse(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A reused PID belongs to a process that started after the daemon wrote its
 * record. The daemon's own process starts before that write, so the check is
 * one-sided on purpose: a slow startup may start well before the record, while
 * a later start cannot be the recorded daemon.
 */
export function processStartMatchesRecord(
  recordStartedAt: string,
  processStartedAt: number | undefined,
): boolean {
  if (processStartedAt === undefined) return true;
  const recorded = Date.parse(recordStartedAt);
  if (!Number.isFinite(recorded)) return true;
  // The daemon starts shortly before it writes the record. A process that
  // started much earlier cannot be it (a pid from another namespace or an
  // older unrelated process), and a later start is a reused pid.
  return (
    processStartedAt >= recorded - PROCESS_START_LEAD_MS &&
    processStartedAt <= recorded + PROCESS_START_TOLERANCE_MS
  );
}

/** The target's command line, used to reject a pid that only shares the
 * number across a PID namespace. */
export function processCommand(pid: number): string | undefined {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return undefined;
    }
    return result.stdout.trim() || undefined;
  }
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

/**
 * Windows has no graceful signal: `process.kill` there is TerminateProcess,
 * which runs no handler and leaves the daemon's children orphaned. The tree is
 * therefore killed as one unit, through the trusted OS-root `taskkill`.
 */
export function terminateTree(pid: number, force: boolean): void {
  if (process.platform === 'win32') {
    const taskkill = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\taskkill.exe`;
    spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
}

export function formatDaemonAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sanitize(value: string): string {
  return sanitizeTerminalText(value).replace(/[\t\n]/g, '');
}

/**
 * Whether `record.pid` names the daemon in this process's PID namespace. A
 * record written in another container (or on another kernel) shares only the
 * number: the pid is neither evidence of life nor of death here, and it must
 * never be signalled. A v1 record without the field keeps the pid check.
 */
export function pidResolvableHere(
  record: DaemonDiscoveryRecord,
  currentNamespace: string | undefined,
): boolean {
  if (record.pidNamespace === undefined) return true;
  if (currentNamespace === undefined) return false;
  return record.pidNamespace === currentNamespace;
}

export async function probeHealth(
  record: DaemonDiscoveryRecord,
): Promise<DaemonHealth> {
  const pidResolvable = pidResolvableHere(record, currentPidNamespace());
  try {
    await fetch(new URL('/health', record.url), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: 'manual',
    });
    // Any HTTP answer — including 401 from --require-auth — proves the
    // listener is alive. The recorded pid can only veto that where it is
    // resolvable: inside one namespace another application may have taken a
    // recycled port, while a foreign namespace simply cannot see the pid.
    return pidResolvable && !isProcessAlive(record.pid) ? 'stale' : 'running';
  } catch {
    // The same asymmetry guards the record: an addressable pid that is gone
    // is stale, but a pid this namespace cannot resolve says nothing.
    return pidResolvable && !isProcessAlive(record.pid)
      ? 'stale'
      : 'unreachable';
  }
}

export function selectDaemonEntries(
  entries: readonly DaemonDiscoveryEntry[],
  options: { port?: number; all?: boolean },
): DaemonDiscoveryEntry[] {
  if (options.port !== undefined) {
    return entries.filter((entry) => entry.record.port === options.port);
  }
  if (options.all === true) {
    return [...entries];
  }
  if (entries.length === 1) {
    return [entries[0]!];
  }
  return [];
}

function selectionError(
  entries: readonly DaemonDiscoveryEntry[],
  options: { port?: number; all?: boolean },
): string | undefined {
  if (options.port !== undefined) {
    return entries.some((entry) => entry.record.port === options.port)
      ? undefined
      : `No daemon is registered on port ${options.port}.`;
  }
  if (options.all === true) return undefined;
  if (entries.length > 1) {
    return (
      `${entries.length} daemons are registered; pass --port <port> ` +
      'or --all to choose one.'
    );
  }
  return undefined;
}

export function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

function fallbackLogPath(): string {
  return path.join(
    path.dirname(resolveDaemonDiscoveryDir()),
    'debug',
    'daemon',
    'daemon.log',
  );
}

function logPathFor(record: DaemonDiscoveryRecord): string {
  return record.logPath && record.logPath.length > 0
    ? record.logPath
    : fallbackLogPath();
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return !isProcessAlive(pid);
}

async function handleStatus(argv: StatusArgs): Promise<void> {
  ignoreBrokenPipe();
  const { entries, invalid } = readDaemonDiscoveries();
  let rows: DaemonStatusRow[] = [];
  for (const entry of entries) {
    rows.push({ entry, health: await probeHealth(entry.record) });
  }

  if (argv.prune === true) {
    const kept: DaemonStatusRow[] = [];
    for (const row of rows) {
      if (row.health !== 'stale') {
        kept.push(row);
        continue;
      }
      // A refused removal means the record is still there — a concurrent
      // instance republished it — so it stays listed under its own pid.
      if (
        !removeDaemonDiscovery(row.entry.record.port, {
          expectedPid: row.entry.record.pid,
        })
      ) {
        kept.push(row);
      }
    }
    rows = kept;
  }

  for (const bad of invalid) {
    writeStderrLine(
      `qwen daemon: ignoring ${sanitize(bad.path)}: ${sanitize(bad.reason)}`,
    );
  }

  if (argv.json === true) {
    for (const row of rows) {
      writeStdoutLine(
        JSON.stringify({
          status: row.health,
          pid: row.entry.record.pid,
          port: row.entry.record.port,
          url: row.entry.record.url,
          workspaces: row.entry.record.workspaces,
          primaryWorkspace: row.entry.record.primaryWorkspace,
          auth: row.entry.record.auth,
          startedAt: row.entry.record.startedAt,
          ageMs: age(row.entry.record.startedAt),
          logPath: logPathFor(row.entry.record),
        }),
      );
    }
    return;
  }

  if (rows.length === 0) {
    writeStdoutLine(
      'No local qwen serve daemon is registered. Start one with `qwen serve`.',
    );
    return;
  }

  writeStdoutLine('STATUS       PID       PORT   AGE   WORKSPACES / URL');
  for (const row of rows) {
    const { record } = row.entry;
    const workspaces = record.workspaces
      .map((workspace) => sanitize(workspace))
      .join(', ');
    writeStdoutLine(
      `${row.health.padEnd(12)}${String(record.pid).padEnd(10)}` +
        `${String(record.port).padEnd(7)}` +
        `${formatDaemonAge(age(record.startedAt)).padEnd(6)}` +
        `${workspaces}  ${sanitize(record.url)}`,
    );
  }
  writeStdoutLine('');
  writeStdoutLine('Use `qwen daemon logs --port <port> --follow` to tail one.');
}

async function printTail(file: string, count: number): Promise<number> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      writeStderrLine(`qwen daemon: log file not found: ${file}`);
      return 0;
    }
    throw error;
  }
  for (const line of tailLines(text, count)) {
    writeStdoutLine(line);
  }
  try {
    return fs.statSync(file).size;
  } catch {
    return Buffer.byteLength(text, 'utf8');
  }
}

export async function followFile(
  file: string,
  startOffset: number,
): Promise<void> {
  let offset = startOffset;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let inode: number | undefined;
  const openCurrent = async (): Promise<void> => {
    try {
      const next = await fsp.open(file, 'r');
      const stat = await next.stat();
      handle = next;
      inode = stat.ino;
    } catch {
      handle = undefined;
      inode = undefined;
    }
  };
  const drain = async (from: number): Promise<number> => {
    if (!handle) return from;
    const stat = await handle.stat();
    if (stat.size <= from) return stat.size;
    const buffer = Buffer.alloc(stat.size - from);
    await handle.read(buffer, 0, buffer.length, from);
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (line.length > 0) writeStdoutLine(line);
    }
    return stat.size;
  };
  await openCurrent();
  writeStderrLine(`qwen daemon: following ${file} (Ctrl+C to stop)`);
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopped) {
      try {
        const stat = await fsp.stat(file);
        if (!handle) {
          await openCurrent();
          offset = 0;
        } else if (inode !== undefined && stat.ino !== inode) {
          // Drain the abandoned file before switching to the replacement.
          offset = await drain(offset);
          await handle.close();
          handle = undefined;
          await openCurrent();
          offset = 0;
        } else {
          if (stat.size < offset) offset = 0;
          offset = await drain(offset);
        }
      } catch (error) {
        // A rotated or removed file is picked up on the next poll; a closed
        // stdout ends the follow instead of spinning.
        if ((error as NodeJS.ErrnoException).code === 'EPIPE') break;
      }
      if (process.stdout.destroyed || !process.stdout.writable) break;
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
    }
  } finally {
    if (handle) await handle.close();
  }
}

async function handleLogs(argv: LogsArgs): Promise<void> {
  ignoreBrokenPipe();
  const { entries } = readDaemonDiscoveries();
  const error = selectionError(entries, argv);
  if (error) {
    writeStderrLine(`qwen daemon: ${error}`);
    process.exitCode = 1;
    return;
  }
  const selected = selectDaemonEntries(entries, argv);
  const entry = selected[0];
  if (!entry) {
    writeStderrLine(
      'qwen daemon: no daemon is registered. Start one with `qwen serve`.',
    );
    process.exitCode = 1;
    return;
  }
  const file = logPathFor(entry.record);
  const count = argv.lines ?? 50;
  if (!Number.isInteger(count) || count <= 0) {
    writeStderrLine('qwen daemon: --lines must be a positive integer.');
    process.exitCode = 1;
    return;
  }
  const offset = await printTail(file, count);
  if (argv.follow === true) {
    await followFile(file, offset);
  }
}

async function handleStop(argv: StopArgs): Promise<void> {
  ignoreBrokenPipe();
  const { entries } = readDaemonDiscoveries();
  const error = selectionError(entries, argv);
  if (error) {
    writeStderrLine(`qwen daemon: ${error}`);
    process.exitCode = 1;
    return;
  }
  const selected = selectDaemonEntries(entries, argv);
  if (selected.length === 0) {
    writeStderrLine(
      'qwen daemon: no daemon is registered. Start one with `qwen serve`.',
    );
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const entry of selected) {
    const { record } = entry;
    const health = await probeHealth(record);
    if (health === 'stale') {
      removeDaemonDiscovery(record.port, { expectedPid: record.pid });
      writeStdoutLine(
        `qwen daemon: removed stale record for port ${record.port} (pid ${record.pid} is gone).`,
      );
      continue;
    }
    if (record.pid === process.pid) {
      writeStderrLine('qwen daemon: refusing to stop the current process.');
      failed = true;
      continue;
    }
    if (!pidResolvableHere(record, currentPidNamespace())) {
      writeStderrLine(
        `qwen daemon: refusing to signal pid ${record.pid}: the record was written in PID namespace ${record.pidNamespace}, which this process cannot address.`,
      );
      failed = true;
      continue;
    }
    const processStarted = processStartTime(record.pid);
    if (processStarted === undefined) {
      writeStderrLine(
        `qwen daemon: refusing to signal pid ${record.pid}: its process start time could not be read.`,
      );
      failed = true;
      continue;
    }
    if (!processStartMatchesRecord(record.startedAt, processStarted)) {
      writeStderrLine(
        `qwen daemon: refusing to signal pid ${record.pid}: its start time does not match the daemon recorded at ${record.startedAt}.`,
      );
      failed = true;
      continue;
    }
    const command = processCommand(record.pid);
    if (
      command === undefined ||
      !command.includes('serve') ||
      !/(qwen|cli\.js)/.test(command)
    ) {
      writeStderrLine(
        `qwen daemon: refusing to signal pid ${record.pid}: its command line is not the recorded daemon.`,
      );
      failed = true;
      continue;
    }
    if (process.platform === 'win32' && argv.force !== true) {
      writeStderrLine(
        'qwen daemon: Windows stop is a hard kill; pass --force to confirm (shutdown handlers do not run).',
      );
      failed = true;
      continue;
    }
    try {
      terminateTree(record.pid, false);
    } catch (killError) {
      writeStderrLine(
        `qwen daemon: could not signal pid ${record.pid}: ${
          killError instanceof Error ? killError.message : String(killError)
        }`,
      );
      failed = true;
      continue;
    }
    const exited = await waitForExit(record.pid, STOP_TIMEOUT_MS);
    if (exited) {
      removeDaemonDiscovery(record.port, { expectedPid: record.pid });
      writeStdoutLine(
        `qwen daemon: ${
          process.platform === 'win32' ? 'hard-killed' : 'stopped'
        } port ${record.port} (pid ${record.pid}).`,
      );
      continue;
    }
    if (argv.force === true) {
      try {
        terminateTree(record.pid, true);
      } catch {
        // Reported below by the final liveness check.
      }
      const forced = await waitForExit(record.pid, STOP_TIMEOUT_MS);
      if (forced) {
        removeDaemonDiscovery(record.port, { expectedPid: record.pid });
        writeStdoutLine(
          `qwen daemon: force-stopped port ${record.port} (pid ${record.pid}).`,
        );
        continue;
      }
    }
    writeStderrLine(
      `qwen daemon: port ${record.port} (pid ${record.pid}) did not exit within ${STOP_TIMEOUT_MS / 1000}s; ` +
        'retry with --force if it is safe to SIGKILL it.',
    );
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

const statusCommand: CommandModule<unknown, StatusArgs> = {
  command: 'status',
  describe: 'List local qwen serve daemons and their health',
  builder: (yargs: Argv) =>
    yargs
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Output one JSON object per daemon',
      })
      .option('prune', {
        type: 'boolean',
        default: false,
        describe: 'Remove records whose process is gone',
      }),
  handler: async (argv) => {
    await handleStatus(argv);
  },
};

const logsCommand: CommandModule<unknown, LogsArgs> = {
  command: 'logs',
  describe: 'Show or follow a local daemon log file',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Daemon port; required when more than one is registered',
      })
      .option('follow', {
        alias: 'f',
        type: 'boolean',
        default: false,
        describe: 'Keep printing new lines',
      })
      .option('lines', {
        alias: 'n',
        type: 'number',
        default: 50,
        describe: 'Number of trailing lines to print first',
      }),
  handler: async (argv) => {
    await handleLogs(argv);
  },
};

const stopCommand: CommandModule<unknown, StopArgs> = {
  command: 'stop',
  describe: 'Stop a local qwen serve daemon',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Daemon port; required when more than one is registered',
      })
      .option('all', {
        type: 'boolean',
        default: false,
        describe: 'Stop every registered daemon',
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe: 'SIGKILL a daemon that does not exit after SIGTERM',
      }),
  handler: async (argv) => {
    await handleStop(argv);
  },
};

export const daemonCommand: CommandModule = {
  command: 'daemon',
  describe: 'Inspect and control local qwen serve daemons',
  builder: (yargs: Argv) =>
    yargs
      .command(statusCommand)
      .command(logsCommand)
      .command(stopCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
