/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getGlobalQwenDirLite,
  resolveConfigPathLite,
} from '../config/storage-paths-lite.js';

export const DAEMON_DISCOVERY_VERSION = 1;

const DISCOVERY_DIR_NAME = 'daemon';
const RECORD_PREFIX = 'daemon-';
const RECORD_SUFFIX = '.json';

export type DaemonDiscoveryAuth = 'none' | 'bearer';

/**
 * A machine-readable record of one live `qwen serve` listener. It is written
 * by the daemon and read by `qwen daemon`. It deliberately carries no bearer
 * token: a served workspace can expose files the daemon owns, so a record
 * inside one must never be a credential store.
 */
export interface DaemonDiscoveryRecord {
  v: typeof DAEMON_DISCOVERY_VERSION;
  pid: number;
  port: number;
  hostname: string;
  url: string;
  workspaces: string[];
  primaryWorkspace: string;
  startedAt: string;
  auth: DaemonDiscoveryAuth;
  tokenGenerated?: boolean;
  /**
   * The explicit startup workspaces, without the persisted registrations the
   * daemon restored at boot. `workspaces` merges both, so only this list can
   * be replayed as `--workspace` without pinning a restored registration.
   * Absent on records written before this field existed.
   */
  startupWorkspaces?: string[];
  /** Whether the Web Shell was enabled at startup. */
  web?: boolean;
  /** Whether `--require-auth` was set at startup. */
  requireAuth?: boolean;
  logPath?: string;
  /**
   * The writer's PID namespace (`pid:[4026531836]`). A reader outside it
   * cannot resolve `pid`, so the number must not be read as proof of life
   * or death, and must never be signalled. Absent on kernels without PID
   * namespaces and on v1 records written before this field existed.
   */
  pidNamespace?: string;
}

export interface DaemonDiscoveryEntry {
  record: DaemonDiscoveryRecord;
  path: string;
}

export interface DaemonDiscoveryReadResult {
  entries: DaemonDiscoveryEntry[];
  invalid: Array<{ path: string; reason: string }>;
}

/**
 * Resolve the directory that holds discovery records. `QWEN_RUNTIME_DIR`
 * wins over `QWEN_HOME`, matching `Storage.getRuntimeBaseDir()` for the
 * standalone CLI case; a daemon started with a different environment writes
 * to a different namespace by design.
 */
export function resolveDaemonDiscoveryDir(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const runtimeDir = env['QWEN_RUNTIME_DIR'];
  const base = runtimeDir
    ? resolveConfigPathLite(runtimeDir)
    : getGlobalQwenDirLite(env);
  return path.join(base, DISCOVERY_DIR_NAME);
}

export function daemonDiscoveryFilePath(
  port: number,
  dir: string = resolveDaemonDiscoveryDir(),
): string {
  return path.join(dir, `${RECORD_PREFIX}${port}${RECORD_SUFFIX}`);
}

export function daemonTokenFilePath(
  port: number,
  pid: number,
  dir: string = resolveDaemonDiscoveryDir(),
): string {
  return path.join(dir, `${RECORD_PREFIX}${port}-${pid}.token`);
}

/**
 * Opt-in token persistence. The file is scoped to the daemon instance's pid,
 * sits beside the 0600 discovery record, and is never referenced by the
 * record or written to the daemon log.
 */
export function writeDaemonToken(
  port: number,
  pid: number,
  token: string,
  dir: string = resolveDaemonDiscoveryDir(),
): string {
  if (token.length === 0) {
    throw new TypeError('A daemon token cannot be empty.');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = daemonTokenFilePath(port, pid, dir);
  fs.writeFileSync(target, `${token}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Filesystems without POSIX modes cannot enforce this.
    }
  }
  return target;
}

export function readDaemonToken(
  port: number,
  pid: number,
  dir: string = resolveDaemonDiscoveryDir(),
): string | undefined {
  try {
    return fs.readFileSync(daemonTokenFilePath(port, pid, dir), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function removeDaemonToken(
  port: number,
  pid: number,
  dir: string = resolveDaemonDiscoveryDir(),
): boolean {
  try {
    fs.unlinkSync(daemonTokenFilePath(port, pid, dir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove token sidecars for the same port that belong to other instances.
 * A new daemon on a reused port must not inherit the previous instance's
 * plaintext credential.
 */
export function removeStaleDaemonTokens(
  port: number,
  keepPid: number,
  dir: string = resolveDaemonDiscoveryDir(),
): string[] {
  const prefix = `${RECORD_PREFIX}${port}-`;
  const suffix = '.token';
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const pid = Number(name.slice(prefix.length, -suffix.length));
    if (!Number.isInteger(pid) || pid === keepPid) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/**
 * The URL a local client can dial. A wildcard bind (`0.0.0.0` / `[::]`) is
 * reachable, but not addressable as written; probe it through loopback the
 * same way `--open` rewrites its browser URL.
 */
export function daemonDiscoveryUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname === '0.0.0.0' || parsed.hostname === '[::]') {
    parsed.hostname = '127.0.0.1';
  }
  return parsed.toString().replace(/\/$/, '');
}

function isValidRecord(value: unknown): value is DaemonDiscoveryRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record['v'] === DAEMON_DISCOVERY_VERSION &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['port'] === 'number' &&
    Number.isInteger(record['port']) &&
    record['port'] > 0 &&
    record['port'] <= 65535 &&
    typeof record['hostname'] === 'string' &&
    typeof record['url'] === 'string' &&
    Array.isArray(record['workspaces']) &&
    record['workspaces'].every(
      (workspace) => typeof workspace === 'string' && workspace.length > 0,
    ) &&
    typeof record['primaryWorkspace'] === 'string' &&
    typeof record['startedAt'] === 'string' &&
    (record['auth'] === 'none' || record['auth'] === 'bearer') &&
    (record['tokenGenerated'] === undefined ||
      typeof record['tokenGenerated'] === 'boolean') &&
    (record['startupWorkspaces'] === undefined ||
      (Array.isArray(record['startupWorkspaces']) &&
        record['startupWorkspaces'].every(
          (workspace) => typeof workspace === 'string' && workspace.length > 0,
        ))) &&
    (record['web'] === undefined || typeof record['web'] === 'boolean') &&
    (record['requireAuth'] === undefined ||
      typeof record['requireAuth'] === 'boolean') &&
    (record['logPath'] === undefined ||
      typeof record['logPath'] === 'string') &&
    (record['pidNamespace'] === undefined ||
      typeof record['pidNamespace'] === 'string')
  );
}

/**
 * This process's PID namespace identity, or undefined where the kernel has
 * none. `pid` only names a process inside the namespace it was read in.
 */
export function currentPidNamespace(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return undefined;
  }
}

/**
 * Atomically publish `record` at `daemon-<port>.json`. The directory is
 * private (0700) and the file is private (0600) on POSIX. Returns the path
 * written so the daemon can remove exactly this record on shutdown.
 */
export function writeDaemonDiscovery(
  record: DaemonDiscoveryRecord,
  dir: string = resolveDaemonDiscoveryDir(),
): string {
  if (!isValidRecord(record)) {
    throw new TypeError('Invalid daemon discovery record.');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // An existing directory on a filesystem without POSIX modes is usable.
    }
  }
  const target = daemonDiscoveryFilePath(record.port, dir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
  return target;
}

export function readDaemonDiscoveries(
  dir: string = resolveDaemonDiscoveryDir(),
): DaemonDiscoveryReadResult {
  const entries: DaemonDiscoveryEntry[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries, invalid };
    }
    throw error;
  }

  for (const name of names.sort()) {
    if (!name.startsWith(RECORD_PREFIX) || !name.endsWith(RECORD_SUFFIX)) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) {
        invalid.push({ path: filePath, reason: 'not a regular file' });
        continue;
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!isValidRecord(parsed)) {
        invalid.push({ path: filePath, reason: 'invalid record' });
        continue;
      }
      entries.push({ record: parsed, path: filePath });
    } catch (error) {
      invalid.push({
        path: filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  entries.sort((a, b) => a.record.port - b.record.port);
  return { entries, invalid };
}

/**
 * Remove the record for `port`. When `expectedPid` is given, a record owned
 * by another process is left untouched — a restarted daemon must not delete
 * the record a concurrent instance just published.
 */
export function removeDaemonDiscovery(
  port: number,
  options: {
    dir?: string;
    expectedPid?: number;
  } = {},
): boolean {
  const dir = options.dir ?? resolveDaemonDiscoveryDir();
  const target = daemonDiscoveryFilePath(port, dir);
  if (options.expectedPid !== undefined) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!isValidRecord(parsed) || parsed.pid !== options.expectedPid) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return false;
    }
  }
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
