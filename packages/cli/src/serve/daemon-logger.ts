/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import lockfile from 'proper-lockfile';
import {
  getGlobalQwenDirLite,
  resolveConfigPathLite,
} from '../config/storage-paths-lite.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export type DaemonLogLevel = 'INFO' | 'WARN' | 'ERROR';
export type DaemonLogMode = 'stable' | 'fallback' | 'stderr-only';
export type DaemonLogHealth = 'ok' | 'degraded';
export type DaemonLogIssue =
  | 'init_failed'
  | 'rotation_failed'
  | 'retention_failed'
  | 'queue_overflow'
  | 'write_failed'
  | 'lease_compromised';

export interface DaemonLoggerStatus {
  runId: string;
  mode: DaemonLogMode;
  health: DaemonLogHealth;
  issues: readonly DaemonLogIssue[];
  droppedRecords: number;
  droppedBytes: number;
}

export interface DaemonLogContext {
  route?: string;
  sessionId?: string;
  clientId?: string;
  childPid?: number;
  channelId?: string;
  [key: string]: unknown;
}

const FIXED_CTX_ORDER = [
  'route',
  'sessionId',
  'clientId',
  'childPid',
  'channelId',
] as const;

const FIXED_CTX_SET: ReadonlySet<string> = new Set(FIXED_CTX_ORDER);
const ISSUE_ORDER: readonly DaemonLogIssue[] = [
  'init_failed',
  'rotation_failed',
  'retention_failed',
  'queue_overflow',
  'write_failed',
  'lease_compromised',
];

const DEFAULT_POLICY: DaemonLoggerPolicy = {
  maxBytes: 10 * 1024 * 1024,
  maxArchives: 4,
  maxRecordBytes: 256 * 1024,
  maxPendingBytes: 4 * 1024 * 1024,
  stableAcquireBudgetMs: 1_000,
  maintenanceAcquireBudgetMs: 250,
  lockStaleMs: 60_000,
  lockUpdateMs: 10_000,
  rotationRetryIntervalMs: 60_000,
  closeDrainBudgetMs: 2_000,
};

const ARCHIVE_RE = /^daemon-(\d{12})-(\d{8}T\d{9}Z)-([0-9a-f]{8})\.log$/;
const FALLBACK_DIR_RE = /^run-[0-9a-f]{32}$/;
const ARCHIVE_NAME_ATTEMPTS = 3;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function renderCtxValue(value: unknown): string {
  const s = String(value);
  return /[\s=]/.test(s) ? JSON.stringify(s) : s;
}

function renderCtx(ctx: DaemonLogContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  for (const key of FIXED_CTX_ORDER) {
    const v = ctx[key];
    if (v !== undefined && v !== null) {
      parts.push(`${key}=${String(v)}`);
    }
  }
  const extraKeys = Object.keys(ctx)
    .filter(
      (key) =>
        !FIXED_CTX_SET.has(key) && ctx[key] !== undefined && ctx[key] !== null,
    )
    .sort();
  for (const key of extraKeys) {
    parts.push(`${key}=${renderCtxValue(ctx[key])}`);
  }
  return parts.length > 0 ? parts.join(' ') + ' ' : '';
}

function renderErr(err: Error | undefined): string {
  if (!err) return '';
  const body = err.stack ?? `${err.name ?? 'Error'}: ${err.message}`;
  return (
    body
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n') + '\n'
  );
}

export interface BuildDaemonLogLineArgs {
  level: DaemonLogLevel;
  message: string;
  now: Date;
  ctx?: DaemonLogContext;
  err?: Error;
}

export function buildDaemonLogLine(args: BuildDaemonLogLineArgs): string {
  const ts = args.now.toISOString();
  const ctxStr = renderCtx(args.ctx);
  return `${ts} [${args.level}] [DAEMON] ${ctxStr}${args.message}\n${renderErr(args.err)}`;
}

function buildDaemonFileLogLine(
  args: BuildDaemonLogLineArgs,
  runId: string,
  pid: number,
): string {
  const callerCtx = args.ctx
    ? Object.fromEntries(
        Object.entries(args.ctx).filter(
          ([key]) => key !== 'runId' && key !== 'pid',
        ),
      )
    : undefined;
  const ctxStr = renderCtx(callerCtx);
  return `${args.now.toISOString()} [${args.level}] [DAEMON] runId=${runId} pid=${pid} ${ctxStr}${args.message}\n${renderErr(args.err)}`;
}

export interface DaemonLogger {
  info(message: string, ctx?: DaemonLogContext): void;
  warn(message: string, ctx?: DaemonLogContext): void;
  error(message: string, err?: Error | null, ctx?: DaemonLogContext): void;
  raw(line: string, level?: 'info' | 'warn' | 'error'): void;
  getLogPath(): string;
  getDaemonId(): string;
  getStatus(): DaemonLoggerStatus;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface DaemonLoggerPolicy {
  maxBytes: number;
  maxArchives: number;
  maxRecordBytes: number;
  maxPendingBytes: number;
  stableAcquireBudgetMs: number;
  maintenanceAcquireBudgetMs: number;
  lockStaleMs: number;
  lockUpdateMs: number;
  rotationRetryIntervalMs: number;
  closeDrainBudgetMs: number;
}

type DaemonLoggerFs = Pick<
  typeof nodeFs.promises,
  | 'appendFile'
  | 'chmod'
  | 'lstat'
  | 'mkdir'
  | 'open'
  | 'readFile'
  | 'readdir'
  | 'rename'
  | 'rm'
  | 'stat'
  | 'symlink'
  | 'unlink'
  | 'writeFile'
>;

type AcquireLock = typeof lockfile.lock;

export interface InitDaemonLoggerOptions {
  boundWorkspace: string;
  pid?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  stderr?: (line: string) => void;
  baseDir?: string;
  runId?: string;
  policy?: Partial<DaemonLoggerPolicy>;
  fs?: DaemonLoggerFs;
  acquireLock?: AcquireLock;
}

interface LeaseHandle {
  compromised: boolean;
  released: boolean;
  release(): Promise<void>;
}

interface ArchiveEntry {
  name: string;
  generation: number;
}

interface DaemonLogFamily {
  mode: 'stable' | 'fallback';
  activePath: string;
  archiveDir: string;
  familyDir: string;
  releaseLease: () => Promise<void>;
  lease: LeaseHandle;
}

interface FileSinkState {
  currentBytes: number;
  archives: ArchiveEntry[];
  nextArchiveGeneration: number;
  archiveAvailable: boolean;
  exclusiveBootCreate: boolean;
  poisoned: boolean;
  nextRotationRetryAt: number;
}

interface ConcreteLoggerHandle {
  logger: DaemonLogger;
  writeInitialRecord(
    record: string,
    forceRotation?: boolean,
  ): Promise<'written' | 'dropped' | 'unknown'>;
}

function getRuntimeBaseDir(runtimeOutputDir?: string, cwd?: string): string {
  const envDir = process.env['QWEN_RUNTIME_DIR'];
  if (envDir) return resolveConfigPathLite(envDir);
  if (runtimeOutputDir) return resolveConfigPathLite(runtimeOutputDir, cwd);
  return getGlobalQwenDirLite();
}

export function resolveDaemonLogBaseDir(
  runtimeOutputDir?: string,
  cwd?: string,
): string {
  return nodePath.join(getRuntimeBaseDir(runtimeOutputDir, cwd), 'debug');
}

function isOptedOut(): boolean {
  const raw = process.env['QWEN_DAEMON_LOG_FILE'];
  if (!raw) return false;
  return ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function computeWorkspaceHash(boundWorkspace: string): string {
  return crypto
    .createHash('sha256')
    .update(boundWorkspace)
    .digest('hex')
    .slice(0, 8);
}

function computeDaemonId(pid: number): string {
  return `daemon:${pid}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function resolvePolicy(
  overrides: Partial<DaemonLoggerPolicy> | undefined,
): DaemonLoggerPolicy {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid daemon logger policy ${name}=${value}`);
    }
  }
  if (
    policy.maxBytes === 0 ||
    policy.maxArchives === 0 ||
    policy.maxRecordBytes === 0 ||
    policy.maxPendingBytes === 0
  ) {
    throw new TypeError(
      'Daemon logger size/count policy values must be positive',
    );
  }
  if (policy.maxRecordBytes > policy.maxBytes) {
    throw new TypeError(
      'Daemon logger maxRecordBytes must not exceed maxBytes',
    );
  }
  if (policy.maxRecordBytes > policy.maxPendingBytes) {
    throw new TypeError(
      'Daemon logger maxRecordBytes must not exceed maxPendingBytes',
    );
  }
  return policy;
}

function statusSnapshot(
  runId: string,
  mode: DaemonLogMode,
  issues: ReadonlySet<DaemonLogIssue>,
  droppedRecords: number,
  droppedBytes: number,
): DaemonLoggerStatus {
  return {
    runId,
    mode,
    health: issues.size === 0 ? 'ok' : 'degraded',
    issues: ISSUE_ORDER.filter((issue) => issues.has(issue)),
    droppedRecords,
    droppedBytes,
  };
}

function createStderrOnlyLogger(input: {
  runId: string;
  daemonId: string;
  now: () => Date;
  stderr: (line: string) => void;
  issues: ReadonlySet<DaemonLogIssue>;
}): DaemonLogger {
  const tee = (
    level: DaemonLogLevel,
    message: string,
    ctx?: DaemonLogContext,
    err?: Error,
  ) => {
    input.stderr(
      buildDaemonLogLine({
        level,
        message,
        now: input.now(),
        ctx,
        err,
      }).trimEnd(),
    );
  };
  return {
    info: (message, ctx) => tee('INFO', message, ctx),
    warn: (message, ctx) => tee('WARN', message, ctx),
    error: (message, err, ctx) => tee('ERROR', message, ctx, err ?? undefined),
    raw: () => {},
    getLogPath: () => '',
    getDaemonId: () => input.daemonId,
    getStatus: () =>
      statusSnapshot(input.runId, 'stderr-only', input.issues, 0, 0),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function capUtf8Record(record: string, maxBytes: number): string {
  const bytes = Buffer.from(record, 'utf8');
  if (bytes.length <= maxBytes) return record;
  const marker = `\n[truncated originalBytes=${bytes.length}]\n`;
  const markerBytes = Buffer.from(marker, 'utf8');
  if (markerBytes.length >= maxBytes) {
    return Buffer.from('[truncated]\n', 'utf8')
      .subarray(0, maxBytes)
      .toString('utf8');
  }
  let prefixBytes = maxBytes - markerBytes.length;
  while (prefixBytes > 0 && (bytes[prefixBytes] & 0xc0) === 0x80) {
    prefixBytes -= 1;
  }
  return bytes.subarray(0, prefixBytes).toString('utf8') + marker;
}

async function ensureRealDirectory(
  fs: DaemonLoggerFs,
  dirPath: string,
  mutationAllowed: () => boolean = () => true,
): Promise<void> {
  try {
    const existing = await fs.lstat(dirPath);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`${dirPath} is not a real directory`);
    }
    return;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (!mutationAllowed()) {
    throw new Error(`File mutation is no longer allowed for ${dirPath}`);
  }
  await fs.mkdir(dirPath, { recursive: true, mode: DIRECTORY_MODE });
  const created = await fs.lstat(dirPath);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`${dirPath} is not a real directory`);
  }
}

async function activeFileSize(
  fs: DaemonLoggerFs,
  activePath: string,
): Promise<number> {
  try {
    const stat = await fs.lstat(activePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${activePath} is not a regular file`);
    }
    return stat.size;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
}

async function lastByteIsNewline(
  fs: DaemonLoggerFs,
  activePath: string,
  size: number,
): Promise<boolean> {
  if (size === 0) return true;
  const handle = await fs.open(activePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1);
    const result = await handle.read(buffer, 0, 1, size - 1);
    return result.bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

async function scanArchives(
  fs: DaemonLoggerFs,
  archiveDir: string,
): Promise<ArchiveEntry[]> {
  const entries = await fs.readdir(archiveDir, { withFileTypes: true });
  const archives: ArchiveEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ARCHIVE_RE.exec(entry.name);
    if (!match) continue;
    archives.push({ name: entry.name, generation: Number(match[1]) });
  }
  archives.sort(
    (a, b) => a.generation - b.generation || a.name.localeCompare(b.name),
  );
  return archives;
}

function lockRetries(maxRetryTime: number): lockfile.LockOptions['retries'] {
  if (maxRetryTime <= 0) return 0;
  return {
    retries: 4,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 400,
    randomize: true,
    maxRetryTime,
  };
}

async function acquireLease(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  targetPath: string;
  lockPath: string;
  policy: DaemonLoggerPolicy;
  retryBudgetMs: number;
  onCompromised?: (error: Error) => void;
}): Promise<LeaseHandle> {
  const lease: LeaseHandle = {
    compromised: false,
    released: false,
    release: async () => {},
  };
  const release = await input.acquireLock(input.targetPath, {
    lockfilePath: input.lockPath,
    realpath: true,
    stale: input.policy.lockStaleMs,
    update: input.policy.lockUpdateMs,
    retries: lockRetries(input.retryBudgetMs),
    onCompromised: (error) => {
      if (lease.released) return;
      lease.compromised = true;
      try {
        input.onCompromised?.(error);
      } catch {
        // A diagnostic sink failure must not restore proper-lockfile's
        // default process-throwing compromise behavior.
      }
    },
  });
  try {
    if (lease.compromised) {
      throw new Error(
        `Lease was compromised while acquiring ${input.lockPath}`,
      );
    }
    await input.fs.chmod(input.lockPath, DIRECTORY_MODE);
  } catch (error) {
    lease.released = true;
    await release().catch(() => {});
    throw error;
  }
  lease.release = async () => {
    if (lease.released) return;
    lease.released = true;
    await release();
  };
  return lease;
}

async function updateLatestBestEffort(
  fs: DaemonLoggerFs,
  daemonDir: string,
  targetPath: string,
  mutationAllowed: () => boolean,
): Promise<void> {
  const linkPath = nodePath.join(daemonDir, 'latest');
  if (!mutationAllowed()) return;
  try {
    await fs.unlink(linkPath);
  } catch {
    // Missing or inaccessible aliases are non-fatal.
  }
  if (!mutationAllowed()) return;
  try {
    await fs.symlink(nodePath.relative(daemonDir, targetPath), linkPath);
  } catch {
    // Symlink creation is best-effort, especially on Windows.
  }
}

async function readRecentFallback(
  fs: DaemonLoggerFs,
  runsDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      nodePath.join(runsDir, 'recent-fallback'),
      'utf8',
    );
    const name = raw.trim();
    return FALLBACK_DIR_RE.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

async function writeRecentFallback(
  fs: DaemonLoggerFs,
  runsDir: string,
  name: string | undefined,
  mutationAllowed: () => boolean = () => true,
): Promise<void> {
  const locatorPath = nodePath.join(runsDir, 'recent-fallback');
  if (!name) {
    if (!mutationAllowed()) {
      throw new Error('Fallback locator mutation is no longer allowed');
    }
    try {
      await fs.unlink(locatorPath);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    return;
  }
  if (!FALLBACK_DIR_RE.test(name)) {
    throw new Error(`Invalid fallback locator target: ${name}`);
  }
  const tempPath = nodePath.join(runsDir, '.recent-fallback.tmp');
  try {
    const tempStat = await fs.lstat(tempPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      throw new Error(`${tempPath} is not a regular file`);
    }
    if (!mutationAllowed()) {
      throw new Error('Fallback locator mutation is no longer allowed');
    }
    await fs.unlink(tempPath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (!mutationAllowed()) {
    throw new Error('Fallback locator mutation is no longer allowed');
  }
  await fs.writeFile(tempPath, `${name}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
    flag: 'wx',
  });
  if (!mutationAllowed()) {
    throw new Error('Fallback locator mutation is no longer allowed');
  }
  await fs.rename(tempPath, locatorPath);
}

async function listFallbackDirectories(
  fs: DaemonLoggerFs,
  runsDir: string,
): Promise<string[]> {
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && FALLBACK_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function fallbackActivityMtime(
  fs: DaemonLoggerFs,
  familyDir: string,
): Promise<number> {
  try {
    return (await fs.lstat(nodePath.join(familyDir, 'daemon.log'))).mtimeMs;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    return (await fs.lstat(familyDir)).mtimeMs;
  }
}

async function cleanupFallbackFamilies(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  runsDir: string;
  preferredInactive?: string;
  mutationAllowed?: () => boolean;
}): Promise<void> {
  const mutationAllowed = input.mutationAllowed ?? (() => true);
  const locator = await readRecentFallback(input.fs, input.runsDir);
  const names = await listFallbackDirectories(input.fs, input.runsDir);
  const live = new Set<string>();
  const inactive: Array<{
    name: string;
    mtimeMs: number;
    lease: LeaseHandle;
  }> = [];
  try {
    for (const name of names) {
      if (!mutationAllowed()) {
        throw new Error('Fallback cleanup lease was compromised');
      }
      const familyDir = nodePath.join(input.runsDir, name);
      let lease: LeaseHandle | undefined;
      try {
        lease = await acquireLease({
          fs: input.fs,
          acquireLock: input.acquireLock,
          targetPath: familyDir,
          lockPath: nodePath.join(familyDir, '.owner.lock'),
          policy: input.policy,
          retryBudgetMs: 0,
        });
        if (!mutationAllowed()) {
          throw new Error('Fallback cleanup lease was compromised');
        }
        if (lease.compromised) {
          await lease.release().catch(() => {});
          throw new Error(`Fallback owner lease was compromised: ${familyDir}`);
        }
        inactive.push({
          name,
          mtimeMs: await fallbackActivityMtime(input.fs, familyDir),
          lease,
        });
      } catch (error) {
        await lease?.release().catch(() => {});
        if (isErrno(error, 'ELOCKED')) {
          live.add(name);
          continue;
        }
        throw error;
      }
    }

    const inactiveNames = new Set(inactive.map((entry) => entry.name));
    const retainedInactive =
      (input.preferredInactive && inactiveNames.has(input.preferredInactive)
        ? input.preferredInactive
        : undefined) ??
      (locator && inactiveNames.has(locator) ? locator : undefined) ??
      inactive
        .slice()
        .sort(
          (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name),
        )[0]?.name;

    for (const entry of inactive) {
      await entry.lease.release();
      if (entry.name === retainedInactive) continue;
      if (!mutationAllowed()) {
        throw new Error('Fallback cleanup lease was compromised');
      }
      await input.fs.rm(nodePath.join(input.runsDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
    const remaining = [...live, ...(retainedInactive ? [retainedInactive] : [])]
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    const nextLocator =
      retainedInactive ??
      (locator && remaining.includes(locator) ? locator : remaining.at(-1));
    if (locator !== nextLocator) {
      await writeRecentFallback(
        input.fs,
        input.runsDir,
        nextLocator,
        mutationAllowed,
      ).catch(() => {});
    }
  } finally {
    await Promise.all(
      inactive
        .filter((entry) => !entry.lease.released)
        .map((entry) => entry.lease.release().catch(() => {})),
    );
  }
}

async function acquireMaintenanceLease(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  runsDir: string;
  retryBudgetMs: number;
}): Promise<LeaseHandle> {
  await ensureRealDirectory(input.fs, input.runsDir);
  return acquireLease({
    fs: input.fs,
    acquireLock: input.acquireLock,
    targetPath: input.runsDir,
    lockPath: nodePath.join(input.runsDir, '.maintenance.lock'),
    policy: input.policy,
    retryBudgetMs: input.retryBudgetMs,
  });
}

async function allocateFallbackFamily(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  daemonDir: string;
  runId: string;
  onCompromised: (error: Error) => void;
}): Promise<DaemonLogFamily> {
  const runsDir = nodePath.join(input.daemonDir, 'runs');
  const maintenance = await acquireMaintenanceLease({
    ...input,
    runsDir,
    retryBudgetMs: input.policy.maintenanceAcquireBudgetMs,
  });
  let familyDir: string | undefined;
  let familyCreated = false;
  let lease: LeaseHandle | undefined;
  const maintenanceAllowsMutation = () =>
    !maintenance.compromised && !maintenance.released;
  try {
    if (!maintenanceAllowsMutation()) {
      throw new Error('Fallback maintenance lease was compromised');
    }
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      mutationAllowed: maintenanceAllowsMutation,
    });
    if (!maintenanceAllowsMutation()) {
      throw new Error('Fallback maintenance lease was compromised');
    }
    const name = `run-${input.runId}`;
    familyDir = nodePath.join(runsDir, name);
    await input.fs.mkdir(familyDir, { mode: DIRECTORY_MODE });
    familyCreated = true;
    if (!maintenanceAllowsMutation()) {
      throw new Error('Fallback maintenance lease was compromised');
    }
    lease = await acquireLease({
      fs: input.fs,
      acquireLock: input.acquireLock,
      targetPath: familyDir,
      lockPath: nodePath.join(familyDir, '.owner.lock'),
      policy: input.policy,
      retryBudgetMs: 0,
      onCompromised: input.onCompromised,
    });
    if (!maintenanceAllowsMutation()) {
      throw new Error('Fallback maintenance lease was compromised');
    }
  } catch (error) {
    await lease?.release().catch(() => {});
    if (familyCreated && familyDir && maintenanceAllowsMutation()) {
      await input.fs
        .rm(familyDir, { recursive: true, force: true })
        .catch(() => {});
    }
    await maintenance.release().catch(() => {});
    throw error;
  }
  try {
    await maintenance.release();
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
  return {
    mode: 'fallback',
    activePath: nodePath.join(familyDir, 'daemon.log'),
    archiveDir: nodePath.join(familyDir, 'archive'),
    familyDir,
    lease,
    releaseLease: lease.release,
  };
}

async function removeFailedFallbackBestEffort(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  family: DaemonLogFamily;
}): Promise<void> {
  if (input.family.lease.compromised) {
    await input.family.releaseLease().catch(() => {});
    return;
  }
  const runsDir = nodePath.dirname(input.family.familyDir);
  let maintenance: LeaseHandle | undefined;
  try {
    maintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0,
    });
  } catch {
    await input.family.releaseLease().catch(() => {});
    return;
  }
  try {
    if (maintenance.compromised) {
      await input.family.releaseLease().catch(() => {});
      return;
    }
    try {
      await input.family.releaseLease();
    } catch {
      return;
    }
    if (maintenance.compromised || input.family.lease.compromised) return;
    await input.fs
      .rm(input.family.familyDir, { recursive: true, force: true })
      .catch(() => {});
  } finally {
    await maintenance.release().catch(() => {});
  }
}

async function closeFallbackFamily(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  family: DaemonLogFamily;
  onRetentionError: (error: unknown) => void;
}): Promise<void> {
  if (input.family.lease.compromised) {
    await input.family.releaseLease().catch(() => {});
    return;
  }
  const runsDir = nodePath.dirname(input.family.familyDir);
  let maintenance: LeaseHandle | undefined;
  try {
    maintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0,
    });
  } catch {
    await input.family.releaseLease().catch(input.onRetentionError);
    return;
  }
  try {
    if (maintenance.compromised) {
      throw new Error('Fallback maintenance lease was compromised');
    }
    await input.family.releaseLease();
    const name = nodePath.basename(input.family.familyDir);
    const mutationAllowed = () =>
      !maintenance.compromised && !input.family.lease.compromised;
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      preferredInactive: name,
      mutationAllowed,
    });
    await writeRecentFallback(input.fs, runsDir, name, mutationAllowed);
  } catch (error) {
    await input.family.releaseLease().catch(input.onRetentionError);
    input.onRetentionError(error);
  } finally {
    await maintenance.release().catch(input.onRetentionError);
  }
}

async function cleanupFallbacksBestEffort(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  daemonDir: string;
  onRetentionError: (error: unknown) => void;
  mutationAllowed?: () => boolean;
}): Promise<void> {
  const runsDir = nodePath.join(input.daemonDir, 'runs');
  try {
    const stat = await input.fs.lstat(runsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${runsDir} is not a real directory`);
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    input.onRetentionError(error);
    return;
  }
  let maintenance: LeaseHandle | undefined;
  try {
    const currentMaintenance = await acquireMaintenanceLease({
      ...input,
      runsDir,
      retryBudgetMs: 0,
    });
    maintenance = currentMaintenance;
    const mutationAllowed = () =>
      !currentMaintenance.compromised &&
      !currentMaintenance.released &&
      (input.mutationAllowed?.() ?? true);
    if (!mutationAllowed()) {
      throw new Error('Fallback maintenance lease was compromised');
    }
    await cleanupFallbackFamilies({
      ...input,
      runsDir,
      mutationAllowed,
    });
  } catch (error) {
    if (!isErrno(error, 'ELOCKED')) input.onRetentionError(error);
  } finally {
    await maintenance?.release().catch(input.onRetentionError);
  }
}

function createConcreteLogger(input: {
  fs: DaemonLoggerFs;
  acquireLock: AcquireLock;
  policy: DaemonLoggerPolicy;
  family: DaemonLogFamily;
  state: FileSinkState;
  runId: string;
  pid: number;
  daemonId: string;
  now: () => Date;
  monotonicNow: () => number;
  stderr: (line: string) => void;
  issues: Set<DaemonLogIssue>;
  warnOnce: (key: string, message: string) => void;
}): ConcreteLoggerHandle {
  let pending: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let droppedRecords = 0;
  let droppedBytes = 0;
  let reportedDroppedRecords = 0;
  let reportedDroppedBytes = 0;
  let overflowEpisode = false;
  let dropSummaryPending = false;
  let acceptingFileRecords = true;
  let closePromise: Promise<void> | undefined;

  const markDropped = (bytes: number, queueOverflow = false) => {
    droppedRecords += 1;
    droppedBytes += bytes;
    if (queueOverflow) {
      input.issues.add('queue_overflow');
      if (!overflowEpisode) {
        overflowEpisode = true;
        input.stderr(
          'qwen serve: daemon log queue limit reached; dropping file copies until capacity recovers',
        );
      }
    }
  };

  const markRotationFailure = (message: string, error?: unknown) => {
    input.issues.add('rotation_failed');
    input.state.nextRotationRetryAt =
      input.monotonicNow() + input.policy.rotationRetryIntervalMs;
    input.warnOnce(
      `rotation:${message}`,
      `qwen serve: daemon log rotation failed; ${message}${
        error
          ? `: ${error instanceof Error ? error.message : String(error)}`
          : ''
      }`,
    );
  };

  const markRetentionFailure = (error: unknown) => {
    input.issues.add('retention_failed');
    input.warnOnce(
      'retention',
      `qwen serve: daemon log retention cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  const fileMutationAllowed = (): boolean =>
    !input.state.poisoned &&
    !input.family.lease.compromised &&
    !input.family.lease.released;

  const prepareArchives = async (): Promise<boolean> => {
    if (
      !input.state.archiveAvailable &&
      input.monotonicNow() < input.state.nextRotationRetryAt
    ) {
      return false;
    }
    try {
      await ensureRealDirectory(
        input.fs,
        input.family.archiveDir,
        fileMutationAllowed,
      );
      if (!fileMutationAllowed()) return false;
      input.state.archives = await scanArchives(
        input.fs,
        input.family.archiveDir,
      );
      input.state.nextArchiveGeneration =
        (input.state.archives.at(-1)?.generation ?? 0) + 1;
      input.state.archiveAvailable = true;
      input.state.nextRotationRetryAt = 0;
      return true;
    } catch (error) {
      if (!fileMutationAllowed()) return false;
      input.state.archiveAvailable = false;
      markRotationFailure('continuing without file rotation', error);
      return false;
    }
  };

  const pruneForRotation = async (): Promise<boolean> => {
    while (input.state.archives.length >= input.policy.maxArchives) {
      if (!fileMutationAllowed()) return false;
      const oldest = input.state.archives[0];
      try {
        await input.fs.unlink(
          nodePath.join(input.family.archiveDir, oldest.name),
        );
        input.state.archives.shift();
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          input.state.archives.shift();
          continue;
        }
        markRetentionFailure(error);
        input.state.nextRotationRetryAt =
          input.monotonicNow() + input.policy.rotationRetryIntervalMs;
        return false;
      }
    }
    return true;
  };

  const archivePath = async (): Promise<ArchiveEntry | undefined> => {
    const generation = input.state.nextArchiveGeneration;
    if (generation > 999_999_999_999) {
      markRotationFailure('archive generation limit reached');
      return undefined;
    }
    for (let attempt = 0; attempt < ARCHIVE_NAME_ATTEMPTS; attempt += 1) {
      let name: string;
      try {
        name = `daemon-${String(generation).padStart(12, '0')}-${archiveTimestamp(input.now())}-${crypto.randomBytes(4).toString('hex')}.log`;
      } catch (error) {
        markRotationFailure('archive filename generation failed', error);
        return undefined;
      }
      const candidate = nodePath.join(input.family.archiveDir, name);
      try {
        await input.fs.lstat(candidate);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return { name, generation };
        markRotationFailure('archive target validation failed', error);
        return undefined;
      }
    }
    markRotationFailure('archive filename collision limit reached');
    return undefined;
  };

  const appendActive = async (
    record: string,
    forceRotation = false,
  ): Promise<'written' | 'dropped' | 'unknown'> => {
    if (!fileMutationAllowed()) return 'dropped';
    const bytes = Buffer.byteLength(record, 'utf8');
    const needsRotation =
      input.state.currentBytes > 0 &&
      (forceRotation ||
        input.state.currentBytes + bytes > input.policy.maxBytes);
    if (needsRotation) {
      if (input.monotonicNow() < input.state.nextRotationRetryAt) {
        return 'dropped';
      }
      if (!(await prepareArchives())) return 'dropped';
      if (!fileMutationAllowed()) return 'dropped';
      if (!(await pruneForRotation())) return 'dropped';
      const archive = await archivePath();
      if (!archive) return 'dropped';
      if (!fileMutationAllowed()) return 'dropped';
      try {
        await input.fs.rename(
          input.family.activePath,
          nodePath.join(input.family.archiveDir, archive.name),
        );
      } catch (error) {
        markRotationFailure('active file rename failed', error);
        return 'dropped';
      }
      input.state.archives.push(archive);
      input.state.archives.sort(
        (a, b) => a.generation - b.generation || a.name.localeCompare(b.name),
      );
      input.state.nextArchiveGeneration = archive.generation + 1;
      input.state.currentBytes = 0;
      if (!fileMutationAllowed()) return 'dropped';
    }

    if (!fileMutationAllowed()) return 'dropped';
    try {
      if (input.state.exclusiveBootCreate) {
        await input.fs.writeFile(input.family.activePath, record, {
          encoding: 'utf8',
          mode: FILE_MODE,
          flag: 'wx',
        });
        input.state.exclusiveBootCreate = false;
      } else {
        await input.fs.appendFile(input.family.activePath, record, {
          encoding: 'utf8',
          mode: FILE_MODE,
          flag: 'a',
        });
      }
      input.state.currentBytes += bytes;
      return 'written';
    } catch (error) {
      input.state.poisoned = true;
      input.issues.add('write_failed');
      input.warnOnce(
        'write-failed',
        `qwen serve: daemon log write failed; file logging disabled for this run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'unknown';
    }
  };

  const unreportedDropRecord = (): string | undefined => {
    const records = droppedRecords - reportedDroppedRecords;
    const bytes = droppedBytes - reportedDroppedBytes;
    if (records <= 0) return undefined;
    return capUtf8Record(
      buildDaemonFileLogLine(
        {
          level: 'WARN',
          message: 'daemon file log records dropped',
          now: input.now(),
          ctx: { droppedRecords: records, droppedBytes: bytes },
        },
        input.runId,
        input.pid,
      ),
      input.policy.maxRecordBytes,
    );
  };

  const enqueueRecord = (
    record: string,
    callerOriginated: boolean,
    onSettled?: (outcome: 'written' | 'dropped' | 'unknown') => void,
  ): boolean => {
    const bytes = Buffer.byteLength(record, 'utf8');
    if (pendingBytes + bytes > input.policy.maxPendingBytes) {
      if (callerOriginated) markDropped(bytes, true);
      return false;
    }
    pendingBytes += bytes;
    pending = pending
      .then(async () => {
        let outcome: 'written' | 'dropped' | 'unknown' = 'unknown';
        try {
          outcome = await appendActive(record);
          if (callerOriginated && outcome === 'dropped') markDropped(bytes);
        } catch (error) {
          input.state.poisoned = true;
          input.issues.add('write_failed');
          input.warnOnce(
            'queue-failed',
            `qwen serve: daemon log queue failed; file logging disabled for this run: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          onSettled?.(outcome);
        }
      })
      .catch(() => {})
      .finally(() => {
        pendingBytes -= bytes;
      });
    return true;
  };

  const enqueueDropSummary = (): void => {
    if (dropSummaryPending) return;
    const summary = unreportedDropRecord();
    if (!summary) return;
    const summaryRecords = droppedRecords;
    const summaryBytes = droppedBytes;
    if (
      enqueueRecord(summary, false, (outcome) => {
        if (outcome === 'written') {
          reportedDroppedRecords = summaryRecords;
          reportedDroppedBytes = summaryBytes;
        }
        dropSummaryPending = false;
      })
    ) {
      dropSummaryPending = true;
      overflowEpisode = false;
    }
  };

  const submitFileRecord = (record: string): void => {
    if (!acceptingFileRecords) return;
    const bytes = Buffer.byteLength(record, 'utf8');
    if (!fileMutationAllowed()) {
      markDropped(bytes);
      return;
    }
    enqueueDropSummary();
    enqueueRecord(record, true);
  };

  const tee = (
    level: DaemonLogLevel,
    message: string,
    ctx?: DaemonLogContext,
    err?: Error,
  ): void => {
    const timestamp = input.now();
    input.stderr(
      buildDaemonLogLine({
        level,
        message,
        now: timestamp,
        ctx,
        err,
      }).trimEnd(),
    );
    submitFileRecord(
      capUtf8Record(
        buildDaemonFileLogLine(
          { level, message, now: timestamp, ctx, err },
          input.runId,
          input.pid,
        ),
        input.policy.maxRecordBytes,
      ),
    );
  };

  const finalize = async (): Promise<void> => {
    await pending;
    const summary = unreportedDropRecord();
    if (summary && !input.state.poisoned && !input.family.lease.compromised) {
      if ((await appendActive(summary)) === 'written') {
        reportedDroppedRecords = droppedRecords;
        reportedDroppedBytes = droppedBytes;
      }
    }
    if (input.family.mode === 'fallback') {
      await closeFallbackFamily({
        ...input,
        onRetentionError: markRetentionFailure,
      });
    } else {
      await input.family.releaseLease().catch((error) => {
        input.warnOnce(
          'release-failed',
          `qwen serve: daemon log lease release failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  };

  const logger: DaemonLogger = {
    info: (message, ctx) => tee('INFO', message, ctx),
    warn: (message, ctx) => tee('WARN', message, ctx),
    error: (message, err, ctx) => tee('ERROR', message, ctx, err ?? undefined),
    raw: (line, level = 'info') => {
      submitFileRecord(
        capUtf8Record(
          buildDaemonFileLogLine(
            {
              level: level.toUpperCase() as DaemonLogLevel,
              message: line,
              now: input.now(),
            },
            input.runId,
            input.pid,
          ),
          input.policy.maxRecordBytes,
        ),
      );
    },
    getLogPath: () => input.family.activePath,
    getDaemonId: () => input.daemonId,
    getStatus: () =>
      statusSnapshot(
        input.runId,
        input.family.mode,
        input.issues,
        droppedRecords,
        droppedBytes,
      ),
    flush: () => pending,
    close: () => {
      if (closePromise) return closePromise;
      acceptingFileRecords = false;
      const finalizer = finalize().catch((error) => {
        try {
          input.warnOnce(
            'close-failed',
            `qwen serve: daemon log close failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } catch {
          // close() is non-rejecting even if stderr itself is unavailable.
        }
      });
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          try {
            input.warnOnce(
              'close-timeout',
              `qwen serve: daemon log close drain exceeded ${input.policy.closeDrainBudgetMs}ms; ownership will release after pending I/O settles or process exit`,
            );
          } catch {
            // close() is non-rejecting even if stderr itself is unavailable.
          } finally {
            resolve();
          }
        }, input.policy.closeDrainBudgetMs);
        timeout.unref();
      });
      closePromise = Promise.race([finalizer, deadline]).then(() => {
        if (timeout) clearTimeout(timeout);
      });
      return closePromise;
    },
  };
  return { logger, writeInitialRecord: appendActive };
}

export async function initDaemonLogger(
  opts: InitDaemonLoggerOptions,
): Promise<DaemonLogger> {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => new Date());
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const stderr = opts.stderr ?? writeStderrLine;
  const baseDir = opts.baseDir ?? resolveDaemonLogBaseDir();
  const runId = opts.runId ?? crypto.randomBytes(16).toString('hex');
  const policy = resolvePolicy(opts.policy);
  const fs = opts.fs ?? nodeFs.promises;
  const acquireLock = opts.acquireLock ?? lockfile.lock;
  const issues = new Set<DaemonLogIssue>();
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      stderr(message);
    } catch {
      // Internal diagnostics must not bypass lease cleanup paths.
    }
  };

  if (isOptedOut()) {
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues,
    });
  }

  const daemonDir = nodePath.join(baseDir, 'daemon');
  try {
    await ensureRealDirectory(fs, daemonDir);
  } catch (error) {
    issues.add('init_failed');
    warnOnce(
      'init',
      `qwen serve: daemon log disabled — init failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues,
    });
  }

  let currentState: FileSinkState | undefined;
  const onCompromised = (error: Error) => {
    issues.add('lease_compromised');
    if (currentState) currentState.poisoned = true;
    warnOnce(
      'lease-compromised',
      `qwen serve: daemon log lease compromised; file logging disabled for this run: ${error.message}`,
    );
  };

  const tryFamily = async (
    family: DaemonLogFamily,
  ): Promise<DaemonLogger | undefined> => {
    let state: FileSinkState;
    try {
      const currentBytes = await activeFileSize(fs, family.activePath);
      if (family.mode === 'fallback' && currentBytes !== 0) {
        throw new Error(
          'New fallback family unexpectedly contains an active log',
        );
      }
      const completeTail = await lastByteIsNewline(
        fs,
        family.activePath,
        currentBytes,
      );
      let archiveAvailable = true;
      let archives: ArchiveEntry[] = [];
      const familyMutationAllowed = () =>
        !family.lease.compromised && !family.lease.released;
      try {
        await ensureRealDirectory(fs, family.archiveDir, familyMutationAllowed);
        if (!familyMutationAllowed()) {
          throw new Error('Daemon log family lease was compromised');
        }
        archives = await scanArchives(fs, family.archiveDir);
      } catch (error) {
        archiveAvailable = false;
        if (familyMutationAllowed()) {
          issues.add('rotation_failed');
          warnOnce(
            `archive-init:${family.mode}`,
            `qwen serve: daemon log archive unavailable; active file will remain bounded: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      state = {
        currentBytes,
        archives,
        nextArchiveGeneration: (archives.at(-1)?.generation ?? 0) + 1,
        archiveAvailable,
        exclusiveBootCreate: family.mode === 'fallback',
        poisoned: false,
        nextRotationRetryAt: archiveAvailable
          ? 0
          : monotonicNow() + policy.rotationRetryIntervalMs,
      };
      currentState = state;
      const concrete = createConcreteLogger({
        fs,
        acquireLock,
        policy,
        family,
        state,
        runId,
        pid,
        daemonId: computeDaemonId(pid),
        now,
        monotonicNow,
        stderr,
        issues,
        warnOnce,
      });
      const bootCtx: DaemonLogContext = {
        workspace: opts.boundWorkspace,
        workspaceHash: computeWorkspaceHash(opts.boundWorkspace),
      };
      const bootTime = now();
      const plainBoot = capUtf8Record(
        buildDaemonFileLogLine(
          {
            level: 'INFO',
            message: 'daemon started',
            now: bootTime,
            ctx: bootCtx,
          },
          runId,
          pid,
        ),
        policy.maxRecordBytes,
      );
      const incompleteTailBoot = !completeTail
        ? `\n${capUtf8Record(
            buildDaemonFileLogLine(
              {
                level: 'INFO',
                message: 'daemon started',
                now: bootTime,
                ctx: { ...bootCtx, previousTailIncomplete: true },
              },
              runId,
              pid,
            ),
            policy.maxRecordBytes - 1,
          )}`
        : plainBoot;
      const wouldRotate =
        currentBytes > 0 &&
        currentBytes + Buffer.byteLength(incompleteTailBoot, 'utf8') >
          policy.maxBytes;
      const bootRecord =
        !completeTail && !wouldRotate ? incompleteTailBoot : plainBoot;
      const bootOutcome = await concrete.writeInitialRecord(
        bootRecord,
        wouldRotate,
      );
      if (
        bootOutcome !== 'written' ||
        state.poisoned ||
        family.lease.compromised
      ) {
        return undefined;
      }
      if (
        state.archiveAvailable &&
        state.archives.length > policy.maxArchives
      ) {
        try {
          while (state.archives.length > policy.maxArchives) {
            if (family.lease.compromised || family.lease.released) break;
            const oldest = state.archives[0];
            if (!oldest) break;
            try {
              await fs.unlink(nodePath.join(family.archiveDir, oldest.name));
            } catch (error) {
              if (!isErrno(error, 'ENOENT')) throw error;
            }
            state.archives.shift();
          }
        } catch (error) {
          issues.add('retention_failed');
          state.nextRotationRetryAt =
            monotonicNow() + policy.rotationRetryIntervalMs;
          warnOnce(
            'startup-retention',
            `qwen serve: daemon log retention cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return concrete.logger;
    } catch (error) {
      warnOnce(
        `family-init:${family.mode}`,
        `qwen serve: daemon ${family.mode} log initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  };

  try {
    const stableLease = await acquireLease({
      fs,
      acquireLock,
      targetPath: daemonDir,
      lockPath: nodePath.join(daemonDir, '.stable-writer.lock'),
      policy,
      retryBudgetMs: policy.stableAcquireBudgetMs,
      onCompromised,
    });
    const stableFamily: DaemonLogFamily = {
      mode: 'stable',
      activePath: nodePath.join(daemonDir, 'daemon.log'),
      archiveDir: nodePath.join(daemonDir, 'archive'),
      familyDir: daemonDir,
      lease: stableLease,
      releaseLease: stableLease.release,
    };
    const stableLogger = await tryFamily(stableFamily);
    if (stableLogger) {
      if (!stableLease.compromised && !stableLease.released) {
        await updateLatestBestEffort(
          fs,
          daemonDir,
          stableFamily.activePath,
          () => !stableLease.compromised && !stableLease.released,
        );
      }
      if (!stableLease.compromised && !stableLease.released) {
        await cleanupFallbacksBestEffort({
          fs,
          acquireLock,
          policy,
          daemonDir,
          mutationAllowed: () =>
            !stableLease.compromised && !stableLease.released,
          onRetentionError: (error) => {
            issues.add('retention_failed');
            warnOnce(
              'fallback-retention',
              `qwen serve: daemon fallback log cleanup failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        });
      }
      return stableLogger;
    }
    issues.add('init_failed');
    try {
      await stableLease.release();
    } catch (error) {
      warnOnce(
        'stable-release',
        `qwen serve: daemon stable log lease release failed; trying fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } catch (error) {
    if (isErrno(error, 'ELOCKED')) {
      warnOnce(
        'stable-contention',
        `qwen serve: daemon stable log is owned by another daemon instance; using a fallback log for runId=${runId}`,
      );
    } else {
      issues.add('init_failed');
      warnOnce(
        'stable-lock',
        `qwen serve: daemon stable log unavailable; trying a fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let fallbackFamily: DaemonLogFamily | undefined;
  try {
    fallbackFamily = await allocateFallbackFamily({
      fs,
      acquireLock,
      policy,
      daemonDir,
      runId,
      onCompromised,
    });
    const activeFallbackFamily = fallbackFamily;
    const fallbackLogger = await tryFamily(activeFallbackFamily);
    if (!fallbackLogger) {
      issues.add('init_failed');
      await removeFailedFallbackBestEffort({
        fs,
        acquireLock,
        policy,
        family: activeFallbackFamily,
      });
      return createStderrOnlyLogger({
        runId,
        daemonId: computeDaemonId(pid),
        now,
        stderr,
        issues,
      });
    }
    const runsDir = nodePath.dirname(activeFallbackFamily.familyDir);
    try {
      if (activeFallbackFamily.lease.compromised) return fallbackLogger;
      const maintenance = await acquireMaintenanceLease({
        fs,
        acquireLock,
        policy,
        runsDir,
        retryBudgetMs: 0,
      });
      try {
        if (!activeFallbackFamily.lease.compromised) {
          await writeRecentFallback(
            fs,
            runsDir,
            nodePath.basename(activeFallbackFamily.familyDir),
            () =>
              !maintenance.compromised &&
              !maintenance.released &&
              !activeFallbackFamily.lease.compromised,
          );
        }
      } finally {
        await maintenance.release();
      }
    } catch (error) {
      warnOnce(
        'fallback-locator',
        `qwen serve: daemon fallback locator update failed; use ${activeFallbackFamily.activePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return fallbackLogger;
  } catch (error) {
    issues.add('init_failed');
    await fallbackFamily?.releaseLease().catch(() => {});
    warnOnce(
      'fallback-init',
      `qwen serve: daemon log disabled — fallback init failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createStderrOnlyLogger({
      runId,
      daemonId: computeDaemonId(pid),
      now,
      stderr,
      issues,
    });
  }
}
