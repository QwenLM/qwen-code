/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandModule, Argv } from 'yargs';
import {
  currentPidNamespace,
  isProcessAlive,
  readDaemonDiscoveries,
  readDaemonToken,
  removeDaemonDiscovery,
  removeDaemonToken,
  removeStaleDaemonTokens,
  resolveDaemonDiscoveryDir,
  writeDaemonToken,
  type DaemonDiscoveryEntry,
  type DaemonDiscoveryRecord,
} from '../serve/daemon-discovery.js';
import { isFullyQualifiedPath } from '../config/storage-paths-lite.js';
import { isLoopbackBind } from '../serve/loopback-binds.js';
import {
  ignoreBrokenPipe,
  writeStderrLine,
  writeStdoutLine,
} from '../utils/stdioHelpers.js';
import { sanitizeTerminalText } from '../ui/utils/textUtils.js';

const HEALTH_TIMEOUT_MS = 1_000;
const DETAIL_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 100;
const FOLLOW_POLL_MS = 250;
const PROCESS_START_TOLERANCE_MS = 5_000;
const PROCESS_START_LEAD_MS = 10 * 60_000;
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 100;
const START_READY_TIMEOUT_MS = 30_000;
const START_READY_POLL_MS = 250;

type DaemonHealth = 'running' | 'unreachable' | 'stale';

interface DaemonStatusRow {
  entry: DaemonDiscoveryEntry;
  health: DaemonHealth;
}

interface StatusArgs {
  json?: boolean;
  prune?: boolean;
  detail?: boolean;
}

interface DaemonDetailSummary {
  status: string;
  version?: string;
  uptimeMs?: number;
  sessions?: { active: number; admissionInFlight?: number };
  issues: string[];
  starting?: boolean;
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

interface RestartArgs {
  port?: number;
  token?: string;
  web?: boolean;
  'require-auth'?: boolean;
  force?: boolean;
}

interface StartArgs {
  port?: number;
  hostname: string;
  workspace?: string | string[];
  web: boolean;
  'require-auth': boolean;
  token?: string;
  'save-token'?: boolean;
  wait?: boolean;
  json?: boolean;
}

interface TokenArgs {
  port?: number;
  json?: boolean;
  remove?: boolean;
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
 * Every process's parent from one snapshot: `ps` on POSIX, CIM on Windows.
 * undefined means the table could not be read.
 */
export function processParentTable(): Map<number, number> | undefined {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
          ],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        )
      : spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }
  const parents = new Map<number, number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(parent)) {
      parents.set(pid!, parent!);
    }
  }
  return parents;
}

/** Whether `ancestor` is on `pid`'s parent chain. */
export function isProcessAncestor(
  ancestor: number,
  pid: number,
  parents: ReadonlyMap<number, number>,
): boolean {
  const seen = new Set<number>();
  let current = parents.get(pid);
  while (current !== undefined && current > 0 && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
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

/**
 * A discovery record and an answering /health prove that a listener exists,
 * not that it is the daemon that wrote the record: a foreign namespace cannot
 * address the pid, and a recycled pid can answer for an unrelated listener.
 * Only call this when the recorded process is addressable here, alive, and
 * started when the record says it did.
 */
export function listenerIdentityVerified(
  record: DaemonDiscoveryRecord,
  currentNamespace: string | undefined = currentPidNamespace(),
  alive: (pid: number) => boolean = isProcessAlive,
  startedAt: (pid: number) => number | undefined = processStartTime,
): boolean {
  if (!pidResolvableHere(record, currentNamespace)) return false;
  if (!alive(record.pid)) return false;
  if (!Number.isFinite(Date.parse(record.startedAt))) return false;
  const started = startedAt(record.pid);
  if (started === undefined) return false;
  return processStartMatchesRecord(record.startedAt, started);
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

export function summarizeDaemonStatus(
  value: unknown,
): DaemonDetailSummary | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const response = value as Record<string, unknown>;
  if (response['v'] !== 1 || typeof response['status'] !== 'string') {
    return undefined;
  }
  const daemon =
    response['daemon'] !== null && typeof response['daemon'] === 'object'
      ? (response['daemon'] as Record<string, unknown>)
      : undefined;
  const runtime =
    response['runtime'] !== null && typeof response['runtime'] === 'object'
      ? (response['runtime'] as Record<string, unknown>)
      : undefined;
  const rawSessions = runtime?.['sessions'];
  const sessions =
    rawSessions !== null && typeof rawSessions === 'object'
      ? (rawSessions as Record<string, unknown>)
      : undefined;
  const issueRecords = Array.isArray(response['issues'])
    ? response['issues'].filter(
        (issue): issue is Record<string, unknown> =>
          issue !== null && typeof issue === 'object',
      )
    : [];
  const issues = issueRecords
    .map((issue) => issue['message'])
    .filter((message): message is string => typeof message === 'string');
  const starting = issueRecords.some(
    (issue) => issue['code'] === 'daemon_runtime_starting',
  );
  const version = daemon?.['qwenCodeVersion'];
  const uptimeMs = daemon?.['uptimeMs'];
  const active = sessions?.['active'];
  const admissionInFlight = sessions?.['admissionInFlight'];
  return {
    status: response['status'],
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof uptimeMs === 'number' ? { uptimeMs } : {}),
    ...(typeof active === 'number'
      ? {
          sessions: {
            active,
            ...(typeof admissionInFlight === 'number'
              ? { admissionInFlight }
              : {}),
          },
        }
      : {}),
    issues,
    ...(starting ? { starting: true } : {}),
  };
}

export function isDaemonReady(
  detail: DaemonDetailSummary | string,
): detail is DaemonDetailSummary {
  return (
    typeof detail !== 'string' &&
    detail.status !== 'error' &&
    detail.starting !== true
  );
}

export async function fetchDaemonDetail(
  record: DaemonDiscoveryRecord,
  allowToken: boolean,
  tokenOverride?: string,
): Promise<DaemonDetailSummary | string> {
  const token =
    record.auth === 'bearer'
      ? tokenOverride?.trim() || process.env['QWEN_SERVER_TOKEN']?.trim()
      : undefined;
  if (token && !allowToken) {
    return 'listener identity unverified; not sending QWEN_SERVER_TOKEN';
  }
  try {
    const response = await fetch(
      new URL('/daemon/status?detail=summary', record.url),
      {
        signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
        redirect: 'manual',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    );
    if (response.status === 401 || response.status === 403) {
      return 'auth required; set QWEN_SERVER_TOKEN';
    }
    if (!response.ok) {
      return `status endpoint returned HTTP ${response.status}`;
    }
    const summary = summarizeDaemonStatus(await response.json());
    return summary ?? 'invalid status response';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function waitForDaemonReady(
  record: DaemonDiscoveryRecord,
  token: string | undefined,
  timeoutMs: number = START_READY_TIMEOUT_MS,
  pollMs: number = START_READY_POLL_MS,
  fetchDetail: (
    record: DaemonDiscoveryRecord,
    allowToken: boolean,
  ) => Promise<DaemonDetailSummary | string> = (candidate, allowToken) =>
    fetchDaemonDetail(candidate, allowToken, token),
  identityVerified: () => boolean = () => listenerIdentityVerified(record),
): Promise<DaemonDetailSummary | string> {
  const deadline = Date.now() + timeoutMs;
  let result: DaemonDetailSummary | string = 'daemon status unavailable';
  while (true) {
    if (!identityVerified()) {
      return 'daemon process exited before readiness';
    }
    result = await fetchDetail(record, true);
    if (isDaemonReady(result)) {
      return identityVerified()
        ? result
        : 'daemon process exited before readiness';
    }
    if (Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function formatDaemonDetail(
  record: DaemonDiscoveryRecord,
  detail: DaemonDetailSummary | string,
): string {
  if (typeof detail === 'string') {
    return `qwen daemon: port ${record.port}: detail unavailable: ${sanitize(detail)}`;
  }
  const uptime =
    detail.uptimeMs === undefined
      ? 'unknown'
      : formatDaemonAge(detail.uptimeMs);
  const sessions =
    detail.sessions === undefined
      ? ''
      : ` sessions=${detail.sessions.active}` +
        (detail.sessions.admissionInFlight === undefined
          ? ''
          : `(+${detail.sessions.admissionInFlight} admitting)`);
  return (
    `qwen daemon: port ${record.port}: status=${sanitize(detail.status)}` +
    ` version=${sanitize(detail.version ?? 'unknown')} uptime=${uptime}` +
    `${sessions} issues=${detail.issues.length}`
  );
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

function resolveCliEntry(): string | undefined {
  const configured = process.env['QWEN_CLI_ENTRY'];
  if (configured) return path.resolve(configured);
  const entry = process.argv[1];
  return entry ? path.resolve(entry) : undefined;
}

function isJavaScriptEntry(entry: string): boolean {
  return /\.(?:c|m)?js$|\.tsx?$/i.test(entry);
}

export function buildDaemonStartArgs(options: {
  entry: string;
  port: number;
  hostname: string;
  workspaces: readonly string[];
  web: boolean;
  requireAuth: boolean;
}): { command: string; args: string[] } {
  const childArgs = [
    'serve',
    '--port',
    String(options.port),
    '--hostname',
    options.hostname,
    '--no-token-qr',
  ];
  if (!options.web) childArgs.push('--no-web');
  if (options.requireAuth) childArgs.push('--require-auth');
  for (const workspace of options.workspaces) {
    childArgs.push('--workspace', workspace);
  }
  return isJavaScriptEntry(options.entry)
    ? {
        command: process.execPath,
        args: [...process.execArgv, options.entry, ...childArgs],
      }
    : { command: options.entry, args: childArgs };
}

export function formatDaemonStartSummary(
  record: DaemonDiscoveryRecord,
): string {
  return [
    `qwen daemon: started pid ${record.pid} on ${record.url}`,
    `qwen daemon: workspace ${record.primaryWorkspace}`,
    `qwen daemon: logs ${logPathFor(record)}`,
    `qwen daemon: stop with \`qwen daemon stop --port ${record.port}\``,
  ].join('\n');
}

const START_ENV_DROP = [
  'QWEN_CODE_CLI',
  'QWEN_CODE_NO_RELAUNCH',
  'QWEN_CODE_SESSION_ID',
  'QWEN_CODE_PROMPT_ID',
  'QWEN_CODE_PROJECT_DIR',
  'QWEN_CODE_SERVE',
  'QWEN_CODE_AGENT_ID',
  'QWEN_DAEMON_TOKEN',
  'QWEN_CODE_MESSAGING_TOKEN',
  'QWEN_CODE_MESSAGING_SOCKET',
] as const;

const START_LOG_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Resolve a runtime/config directory against the launching directory unless
 * it is already fully qualified. On Windows, `\runtime` and `/runtime` are
 * absolute but depend on the current drive, so only drive-letter and UNC
 * forms are fixed.
 */
export function resolveStartEnvPath(
  value: string | undefined,
  cwd: string,
  pathApi: Pick<typeof path, 'isAbsolute' | 'resolve'> = path,
  fullyQualified: (candidate: string) => boolean = isFullyQualifiedPath,
): string | undefined {
  if (value === undefined) return undefined;
  // An explicit empty value is meaningful: the environment bootstrap uses
  // Object.hasOwn to distinguish it from an unset variable.
  if (value === '') return '';
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return value;
  }
  return fullyQualified(value) ? value : pathApi.resolve(cwd, value);
}

/**
 * The child is a new daemon, not a worker of the session that launched it.
 * Drop the parent's session/worker bindings and every private marker, then
 * pin relative runtime directories to the launching directory so the parent
 * and child keep using the same discovery/config namespace after the child
 * changes its cwd to the workspace. The operator's model/auth environment is
 * kept.
 */
export function buildDaemonStartEnv(
  env: NodeJS.ProcessEnv,
  token: string | undefined,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const key of START_ENV_DROP) {
    delete child[key];
  }
  for (const key of Object.keys(child)) {
    if (key.startsWith('QWEN_CODE_PRIVATE_')) {
      delete child[key];
    }
  }
  for (const key of ['QWEN_RUNTIME_DIR', 'QWEN_HOME'] as const) {
    const resolved = resolveStartEnvPath(child[key], cwd);
    if (resolved === undefined) {
      delete child[key];
    } else {
      child[key] = resolved;
    }
  }
  if (token) child['QWEN_SERVER_TOKEN'] = token;
  return child;
}

/**
 * Remove startup logs left by failed starts after a retention window.
 */
export function sweepStaleStartLogs(dir: string, now = Date.now()): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('start-') || !name.endsWith('.log')) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > START_LOG_MAX_AGE_MS) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Best-effort sweep.
      }
    }
  } catch {
    // The discovery directory may not exist yet.
  }
}

export async function canonicalizeStartWorkspaces(
  rawWorkspaces: readonly string[],
): Promise<string[]> {
  const { validateAndCanonicalizeWorkspaceInput } = await import(
    '../serve/run-qwen-serve.js'
  );
  return rawWorkspaces.map((workspace) =>
    validateAndCanonicalizeWorkspaceInput(path.resolve(workspace)),
  );
}

async function printStartLogTail(file: string): Promise<void> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of tailLines(text, 40)) {
      writeStderrLine(line);
    }
  } catch {
    // The spawn may fail before the log has any content.
  }
}

async function handleStart(argv: StartArgs): Promise<void> {
  ignoreBrokenPipe();
  const entry = resolveCliEntry();
  if (!entry) {
    writeStderrLine(
      'qwen daemon: cannot determine the CLI entry; run `qwen serve` directly.',
    );
    process.exitCode = 1;
    return;
  }

  const rawWorkspaces = Array.isArray(argv.workspace)
    ? argv.workspace
    : argv.workspace
      ? [argv.workspace]
      : [process.cwd()];
  let workspaces: string[];
  try {
    workspaces = await canonicalizeStartWorkspaces(rawWorkspaces);
  } catch (error) {
    writeStderrLine(
      `qwen daemon: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const hostname = argv.hostname;
  const port = argv.port ?? 4170;
  const token =
    argv.token?.trim() || process.env['QWEN_SERVER_TOKEN']?.trim() || undefined;
  if (argv['require-auth'] && !token) {
    writeStderrLine(
      'qwen daemon: --require-auth requires --token or QWEN_SERVER_TOKEN.',
    );
    process.exitCode = 1;
    return;
  }
  if (argv['save-token'] && !token) {
    writeStderrLine(
      'qwen daemon: --save-token requires --token or QWEN_SERVER_TOKEN.',
    );
    process.exitCode = 1;
    return;
  }
  if (!isLoopbackBind(hostname) && !token) {
    writeStderrLine(
      'qwen daemon: a non-loopback bind requires QWEN_SERVER_TOKEN; ' +
        'run `qwen serve` directly if you want an ephemeral token.',
    );
    process.exitCode = 1;
    return;
  }
  if (argv.token) {
    writeStderrLine(
      'qwen daemon: --token is visible in this shell process list; prefer QWEN_SERVER_TOKEN.',
    );
  }

  const primary = workspaces[0]!;
  const existing = readDaemonDiscoveries().entries.find(
    (candidate) =>
      candidate.record.primaryWorkspace === primary &&
      isProcessAlive(candidate.record.pid) &&
      processStartMatchesRecord(
        candidate.record.startedAt,
        processStartTime(candidate.record.pid),
      ),
  );
  if (existing && argv.port === undefined) {
    writeStderrLine(
      `qwen daemon: a daemon is already running for ${primary} on port ${existing.record.port}; pass --port to start another.`,
    );
    process.exitCode = 1;
    return;
  }

  const logDir = resolveDaemonDiscoveryDir();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  sweepStaleStartLogs(logDir);
  const startLog = path.join(logDir, `start-${process.pid}-${Date.now()}.log`);
  const logFd = fs.openSync(startLog, 'a', 0o600);
  const { command, args } = buildDaemonStartArgs({
    entry,
    port,
    hostname,
    workspaces,
    web: argv.web,
    requireAuth: argv['require-auth'],
  });
  const env = buildDaemonStartEnv(process.env, token);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: primary,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } catch (error) {
    fs.closeSync(logFd);
    writeStderrLine(
      `qwen daemon: could not spawn the daemon: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }
  fs.closeSync(logFd);

  if (child.pid === undefined) {
    writeStderrLine('qwen daemon: the daemon process did not start.');
    process.exitCode = 1;
    return;
  }
  child.unref();

  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });

  // The record pid is the spawned child: serve blocks in blockForever() after
  // its listener is ready, so the CLI relaunch path cannot replace it.
  const deadline = Date.now() + START_TIMEOUT_MS;
  let record: DaemonDiscoveryRecord | undefined;
  while (Date.now() < deadline) {
    if (spawnError) break;
    record = readDaemonDiscoveries().entries.find(
      (candidate) => candidate.record.pid === child.pid,
    )?.record;
    if (record) break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }

  if (record) {
    removeStaleDaemonTokens(record.port, record.pid);
    if (argv['save-token']) {
      try {
        writeDaemonToken(record.port, record.pid, token!);
      } catch (error) {
        writeStderrLine(
          `qwen daemon: could not persist the token: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
        return;
      }
    }
    const ready =
      argv.wait === true ? await waitForDaemonReady(record, token) : undefined;
    const readyFailed = ready !== undefined && !isDaemonReady(ready);

    if (argv.json === true) {
      writeStdoutLine(
        JSON.stringify({
          pid: record.pid,
          port: record.port,
          url: record.url,
          workspaces: record.workspaces,
          primaryWorkspace: record.primaryWorkspace,
          logPath: logPathFor(record),
        }),
      );
    } else {
      writeStdoutLine(formatDaemonStartSummary(record));
    }

    if (readyFailed) {
      writeStderrLine(
        `qwen daemon: daemon pid ${record.pid} is running but did not report ready within ${
          START_READY_TIMEOUT_MS / 1000
        }s.`,
      );
      if (typeof ready === 'string') {
        writeStderrLine(`qwen daemon: ${ready}`);
      }
      writeStderrLine(`qwen daemon: startup log: ${startLog}`);
      process.exitCode = 1;
      return;
    }

    try {
      fs.rmSync(startLog, { force: true });
    } catch {
      // Startup output is no longer needed after the record is published.
    }
    return;
  }

  writeStderrLine(
    `qwen daemon: daemon pid ${child.pid} did not publish a discovery record within ${
      START_TIMEOUT_MS / 1000
    }s. The detached child may still start; run \`qwen daemon status\` to check.`,
  );
  if (spawnError) {
    writeStderrLine(`qwen daemon: spawn failed: ${spawnError.message}`);
  }
  writeStderrLine(`qwen daemon: startup log: ${startLog}`);
  await printStartLogTail(startLog);
  process.exitCode = 1;
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
      } else {
        removeDaemonToken(row.entry.record.port, row.entry.record.pid);
      }
    }
    rows = kept;
  }

  for (const bad of invalid) {
    writeStderrLine(
      `qwen daemon: ignoring ${sanitize(bad.path)}: ${sanitize(bad.reason)}`,
    );
  }

  const details = new Map<number, DaemonDetailSummary | string>();
  if (argv.detail === true) {
    await Promise.all(
      rows
        .filter((row) => row.health === 'running')
        .map(async (row) => {
          const record = row.entry.record;
          const allowToken =
            record.auth === 'bearer' && listenerIdentityVerified(record);
          details.set(record.port, await fetchDaemonDetail(record, allowToken));
        }),
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
          ...(argv.detail === true
            ? { detail: details.get(row.entry.record.port) ?? null }
            : {}),
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
  if (argv.detail === true) {
    for (const row of rows) {
      const detail = details.get(row.entry.record.port);
      if (detail !== undefined) {
        writeStdoutLine(formatDaemonDetail(row.entry.record, detail));
      } else {
        writeStdoutLine(
          `qwen daemon: port ${row.entry.record.port}: detail unavailable (${row.health})`,
        );
      }
    }
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
      if (removeDaemonDiscovery(record.port, { expectedPid: record.pid })) {
        removeDaemonToken(record.port, record.pid);
      }
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
      if (removeDaemonDiscovery(record.port, { expectedPid: record.pid })) {
        removeDaemonToken(record.port, record.pid);
      }
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
        if (removeDaemonDiscovery(record.port, { expectedPid: record.pid })) {
          removeDaemonToken(record.port, record.pid);
        }
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

async function handleToken(argv: TokenArgs): Promise<void> {
  ignoreBrokenPipe();
  const { entries } = readDaemonDiscoveries();
  const error = selectionError(entries, { port: argv.port });
  if (error) {
    writeStderrLine(`qwen daemon: ${error}`);
    process.exitCode = 1;
    return;
  }
  const selected = selectDaemonEntries(entries, { port: argv.port });
  if (selected.length !== 1) {
    writeStderrLine(
      'qwen daemon: token needs exactly one registered daemon; pass --port.',
    );
    process.exitCode = 1;
    return;
  }

  const record = selected[0]!.record;
  if (argv.remove === true) {
    const removed = removeDaemonToken(record.port, record.pid);
    if (!removed) {
      writeStderrLine(
        `qwen daemon: no persisted token for port ${record.port}.`,
      );
      process.exitCode = 1;
      return;
    }
    writeStdoutLine(
      argv.json === true
        ? JSON.stringify({ port: record.port, removed: true })
        : `qwen daemon: removed persisted token for port ${record.port}.`,
    );
    return;
  }

  const token = readDaemonToken(record.port, record.pid);
  if (!token) {
    writeStderrLine(
      `qwen daemon: no persisted token for port ${record.port}; start with --save-token or use QWEN_SERVER_TOKEN.`,
    );
    process.exitCode = 1;
    return;
  }
  writeStdoutLine(
    argv.json === true
      ? JSON.stringify({ port: record.port, token })
      : `qwen daemon: token for port ${record.port}: ${token}`,
  );
}

export interface DaemonRestartPlan {
  error?: string;
  /** Lines printed before the stop leg. */
  notices?: string[];
  command?: string;
  stopArgs?: string[];
  startArgs?: string[];
  workspaces?: string[];
  env?: NodeJS.ProcessEnv;
}

export function buildDaemonRestartPlan(
  record: DaemonDiscoveryRecord,
  options: {
    token?: string;
    web?: boolean;
    requireAuth?: boolean;
    force?: boolean;
  },
  entry: string,
  execArgv: readonly string[] = process.execArgv,
  baseEnv: NodeJS.ProcessEnv = process.env,
): DaemonRestartPlan {
  let protocol = '';
  try {
    protocol = new URL(record.url).protocol;
  } catch {
    // An unparseable record was already rejected by the discovery reader.
  }
  if (protocol === 'https:') {
    return {
      error:
        'restarting an HTTPS daemon is not supported; restart it with qwen serve and the original TLS settings.',
    };
  }

  // `workspaces` also holds the registrations restored at boot. Replaying
  // those as `--workspace` would turn a forgettable registration into a
  // startup workspace, so an older record is replayable only when it cannot
  // contain one.
  const workspaces = record.startupWorkspaces?.length
    ? record.startupWorkspaces
    : record.workspaces.length <= 1
      ? [record.primaryWorkspace]
      : undefined;
  if (!workspaces) {
    return {
      error:
        `the daemon on port ${record.port} was started by an older qwen that did not record its startup workspaces; ` +
        `stop it and start it again with \`qwen daemon start --port ${record.port} --workspace <path>\`.`,
    };
  }

  const notices: string[] = [];
  const web = options.web ?? record.web;
  if (web === undefined) {
    notices.push(
      'the record does not say whether the Web Shell was enabled; restarting with it (pass --no-web for API-only).',
    );
  }
  const requireAuth =
    options.requireAuth ?? record.requireAuth ?? record.auth === 'bearer';
  if (
    options.requireAuth === undefined &&
    record.requireAuth === undefined &&
    record.auth === 'bearer'
  ) {
    notices.push(
      'the record does not say whether --require-auth was set; restarting with it (pass --no-require-auth to keep /health open on loopback).',
    );
  }

  const explicitToken = options.token?.trim() || undefined;
  const token =
    explicitToken ?? (baseEnv['QWEN_SERVER_TOKEN']?.trim() || undefined);
  // An explicit --token configures bearer auth, as it does for `daemon start`;
  // an inherited QWEN_SERVER_TOKEN must not add auth to an auth-none daemon.
  const bearer =
    record.auth === 'bearer' || requireAuth || explicitToken !== undefined;
  if (bearer && !token) {
    return {
      error:
        record.auth !== 'bearer'
          ? '--require-auth requires --token or QWEN_SERVER_TOKEN.'
          : record.tokenGenerated === true
            ? `the daemon on port ${record.port} uses a token generated at startup, which is not recorded; ` +
              'pass that token with --token or QWEN_SERVER_TOKEN, or stop the daemon and run `qwen serve` again.'
            : 'restarting a bearer daemon requires --token or QWEN_SERVER_TOKEN; ' +
              'a token in a workspace .env or settings file is not read here.',
    };
  }
  if (options.token) {
    notices.push(
      '--token is visible in this shell process list; prefer QWEN_SERVER_TOKEN.',
    );
  }

  const javaScriptEntry = isJavaScriptEntry(entry);
  const command = javaScriptEntry ? process.execPath : entry;
  const prefix = javaScriptEntry ? [...execArgv, entry] : [];
  const env = { ...baseEnv };
  if (bearer) {
    env['QWEN_SERVER_TOKEN'] = token!;
  } else {
    delete env['QWEN_SERVER_TOKEN'];
  }

  const stopArgs = [...prefix, 'daemon', 'stop', '--port', String(record.port)];
  if (options.force) stopArgs.push('--force');

  const startArgs = [
    ...prefix,
    'daemon',
    'start',
    '--port',
    String(record.port),
    '--hostname',
    record.hostname,
    '--wait',
  ];
  for (const workspace of workspaces) {
    startArgs.push('--workspace', workspace);
  }
  if (web === false) startArgs.push('--no-web');
  if (requireAuth) startArgs.push('--require-auth');

  return { notices, command, stopArgs, startArgs, workspaces, env };
}

/**
 * Restart addresses one daemon, so it does not borrow `stop`'s `--all`
 * advice.
 */
export function selectRestartTarget(
  entries: readonly DaemonDiscoveryEntry[],
  port: number | undefined,
): { entry?: DaemonDiscoveryEntry; error?: string } {
  if (port !== undefined) {
    const entry = entries.find((candidate) => candidate.record.port === port);
    return entry
      ? { entry }
      : { error: `No daemon is registered on port ${port}.` };
  }
  if (entries.length === 0) {
    return { error: 'no daemon is registered. Start one with `qwen serve`.' };
  }
  if (entries.length > 1) {
    return {
      error: `${entries.length} daemons are registered; pass --port <port> to choose one.`,
    };
  }
  return { entry: entries[0]! };
}

/**
 * Whether a running bearer daemon rejects `token`. Only a verified listener
 * is sent the credential, and only a 401 proves a mismatch.
 */
export async function daemonRejectsToken(
  record: DaemonDiscoveryRecord,
  token: string,
  allowToken: boolean = listenerIdentityVerified(record),
): Promise<boolean> {
  if (!allowToken) return false;
  try {
    const response = await fetch(
      new URL('/daemon/status?detail=summary', record.url),
      {
        signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
        redirect: 'manual',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return response.status === 401;
  } catch {
    return false;
  }
}

export interface DaemonRestartDeps {
  run(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): { status: number | null; error?: Error };
  entries(): readonly DaemonDiscoveryEntry[];
  hostedBy(pid: number): boolean;
  validateWorkspaces(workspaces: readonly string[]): Promise<unknown>;
  rejectsToken(record: DaemonDiscoveryRecord, token: string): Promise<boolean>;
}

const defaultRestartDeps: DaemonRestartDeps = {
  run: (command, args, env) =>
    spawnSync(command, [...args], { stdio: 'inherit', env }),
  entries: () => readDaemonDiscoveries().entries,
  hostedBy: (pid) => {
    const parents = processParentTable();
    return (
      parents !== undefined && isProcessAncestor(pid, process.pid, parents)
    );
  },
  validateWorkspaces: canonicalizeStartWorkspaces,
  rejectsToken: (record, token) => daemonRejectsToken(record, token),
};

/**
 * Run the stop and start legs of a restart and return the exit code. Every
 * refusal that can be decided while the daemon still runs is decided before
 * the stop leg.
 */
export async function runDaemonRestart(
  record: DaemonDiscoveryRecord,
  plan: DaemonRestartPlan,
  deps: DaemonRestartDeps = defaultRestartDeps,
): Promise<number> {
  if (plan.error) {
    writeStderrLine(`qwen daemon: ${plan.error}`);
    return 1;
  }
  for (const notice of plan.notices ?? []) {
    writeStderrLine(`qwen daemon: ${notice}`);
  }
  // Stopping the daemon tears down the shells it hosts (Web Shell terminals
  // and agent shell tools), and this command with them, before the start leg.
  if (
    pidResolvableHere(record, currentPidNamespace()) &&
    deps.hostedBy(record.pid)
  ) {
    writeStderrLine(
      `qwen daemon: refusing to restart port ${record.port} from a process that daemon hosts, such as its Web Shell terminal; ` +
        'stopping it would end this command before the new daemon starts. Run restart from a shell outside the daemon.',
    );
    return 1;
  }
  try {
    await deps.validateWorkspaces(plan.workspaces!);
  } catch (error) {
    writeStderrLine(
      `qwen daemon: cannot restart: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  const token = plan.env?.['QWEN_SERVER_TOKEN'];
  if (
    record.auth === 'bearer' &&
    token &&
    (await deps.rejectsToken(record, token))
  ) {
    writeStderrLine(
      `qwen daemon: the daemon on port ${record.port} rejected the supplied token. ` +
        'Restart keeps the daemon credential; pass its current token, or stop it and start it with the new one.',
    );
    return 1;
  }

  // Preserve an opted-in persisted token across the instance change. The
  // sidecar belongs to the old pid and is removed by the stop leg; capture it
  // before stopping, then recreate it for the pid that actually started.
  const persistedToken = readDaemonToken(record.port, record.pid);

  const stopped = deps.run(plan.command!, plan.stopArgs!, plan.env!);
  if (stopped.error) {
    writeStderrLine(
      `qwen daemon: could not run daemon stop: ${stopped.error.message}`,
    );
    return 1;
  }
  if (stopped.status !== 0) {
    // Every stop refusal leaves the record in place. A missing record means
    // the daemon exited on its own while the stop leg started.
    if (deps.entries().some((entry) => entry.record.port === record.port)) {
      return 1;
    }
    writeStdoutLine(
      `qwen daemon: the daemon on port ${record.port} already exited; starting it again.`,
    );
  }

  const started = deps.run(plan.command!, plan.startArgs!, plan.env!);
  if (started.error) {
    writeStderrLine(
      `qwen daemon: could not run daemon start: ${started.error.message}`,
    );
    writeStderrLine(
      `qwen daemon: the daemon on port ${record.port} is stopped.`,
    );
    return 1;
  }
  if (started.status !== 0) return 1;

  // serve moves to the next free port when the recorded one is taken, and
  // the start leg succeeds wherever it landed.
  const restarted = deps
    .entries()
    .find(
      (entry) =>
        entry.record.port === record.port &&
        (entry.record.pid !== record.pid ||
          entry.record.startedAt !== record.startedAt),
    );
  if (!restarted) {
    writeStderrLine(
      `qwen daemon: the restarted daemon is not on port ${record.port}; the port may be in use. Run \`qwen daemon status\` to find it.`,
    );
    return 1;
  }
  if (persistedToken !== undefined) {
    const tokenToPersist = plan.env?.['QWEN_SERVER_TOKEN'] ?? persistedToken;
    try {
      writeDaemonToken(record.port, restarted.record.pid, tokenToPersist);
    } catch (error) {
      writeStderrLine(
        `qwen daemon: could not persist the token for the restarted daemon: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  }
  return 0;
}

async function handleRestart(argv: RestartArgs): Promise<void> {
  ignoreBrokenPipe();
  const target = selectRestartTarget(
    readDaemonDiscoveries().entries,
    argv.port,
  );
  if (!target.entry) {
    writeStderrLine(`qwen daemon: ${target.error}`);
    process.exitCode = 1;
    return;
  }

  const entry = resolveCliEntry();
  if (!entry) {
    writeStderrLine(
      'qwen daemon: cannot determine the CLI entry; restart requires the qwen CLI.',
    );
    process.exitCode = 1;
    return;
  }

  const { record } = target.entry;
  const plan = buildDaemonRestartPlan(
    record,
    {
      token: argv.token,
      web: argv.web,
      requireAuth: argv['require-auth'],
      force: argv.force,
    },
    entry,
  );
  if ((await runDaemonRestart(record, plan)) !== 0) process.exitCode = 1;
}

const startCommand: CommandModule<unknown, StartArgs> = {
  command: 'start',
  describe: 'Start a local qwen serve daemon in the background',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'TCP port (default 4170; 0 picks an ephemeral port)',
      })
      .option('hostname', {
        type: 'string',
        default: '127.0.0.1',
        describe: 'Interface to bind',
      })
      .option('workspace', {
        type: 'string',
        array: true,
        requiresArg: true,
        describe:
          'Workspace path; repeat for multiple; defaults to the current directory',
      })
      .option('web', {
        type: 'boolean',
        default: true,
        describe: 'Serve the Web Shell; use --no-web for API-only',
      })
      .option('require-auth', {
        type: 'boolean',
        default: false,
        describe: 'Require the bearer token even on loopback',
      })
      .option('token', {
        type: 'string',
        describe: 'Bearer token for the child; prefer QWEN_SERVER_TOKEN',
      })
      .option('save-token', {
        type: 'boolean',
        default: false,
        describe: 'Persist the bearer token in a 0600 sidecar for daemon token',
      })
      .option('wait', {
        type: 'boolean',
        default: false,
        describe: 'Wait until the daemon runtime is serving before returning',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Output a JSON summary',
      }),
  handler: async (argv) => {
    await handleStart(argv);
  },
};

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
      })
      .option('detail', {
        type: 'boolean',
        default: false,
        describe:
          'Fetch /daemon/status for version, uptime, active sessions, and issue count',
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

const restartCommand: CommandModule<unknown, RestartArgs> = {
  command: 'restart',
  describe:
    'Restart a local qwen serve daemon on its recorded port and workspaces',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Daemon port; required when more than one is registered',
      })
      .option('token', {
        type: 'string',
        describe:
          'Bearer token for the restarted daemon; a running bearer daemon must accept it. Prefer QWEN_SERVER_TOKEN',
      })
      .option('web', {
        type: 'boolean',
        describe:
          'Serve the Web Shell; defaults to the recorded mode, use --no-web for API-only',
      })
      .option('require-auth', {
        type: 'boolean',
        describe:
          'Require the bearer token even on loopback; defaults to the recorded setting',
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe:
          'Pass --force to daemon stop: confirm the Windows hard kill, or SIGKILL a POSIX daemon that does not exit after SIGTERM',
      }),
  handler: async (argv) => {
    await handleRestart(argv);
  },
};

const tokenCommand: CommandModule<unknown, TokenArgs> = {
  command: 'token',
  describe: 'Show or remove a persisted daemon bearer token',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        describe: 'Daemon port; required when more than one is registered',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Output a JSON object',
      })
      .option('remove', {
        type: 'boolean',
        default: false,
        describe: 'Remove the persisted token',
      }),
  handler: async (argv) => {
    await handleToken(argv);
  },
};

export const daemonCommand: CommandModule = {
  command: 'daemon',
  describe: 'Inspect and control local qwen serve daemons',
  builder: (yargs: Argv) =>
    yargs
      .command(startCommand)
      .command(statusCommand)
      .command(logsCommand)
      .command(stopCommand)
      .command(restartCommand)
      .command(tokenCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
