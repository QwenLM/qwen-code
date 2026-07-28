/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

export const LIVE_DISCOVERY_RELATIVE_PATH = path.join('live', 'daemon.json');
const MAX_DISCOVERY_BYTES = 16 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: {
    retries: 120,
    minTimeout: 10,
    maxTimeout: 100,
    factor: 1.2,
    randomize: true,
  },
};

export interface LiveDiscoveryRecord {
  url: string;
  token?: string;
  protocolVersion: typeof LIVE_HOST_PROTOCOL_VERSION;
  pid: number;
  instanceNonce: string;
}

export interface LiveDiscoveryOwner {
  pid: number;
  instanceNonce: string;
}

interface ExistingLiveDiscoveryRecord {
  url: string;
  token?: string;
  protocolVersion: number;
  pid: number;
  instanceNonce: string;
}

export class LiveDiscoveryOwnerActiveError extends Error {
  constructor(readonly ownerPid: number) {
    super(`Live discovery is owned by active daemon pid ${ownerPid}.`);
    this.name = 'LiveDiscoveryOwnerActiveError';
  }
}

export function getStableLiveDiscoveryBaseDir(
  homeDirectory = homedir(),
): string {
  return path.join(homeDirectory, '.qwen');
}

export function getLiveDiscoveryPath(runtimeBaseDir: string): string {
  return path.join(runtimeBaseDir, LIVE_DISCOVERY_RELATIVE_PATH);
}

function assertSafeRecord(record: ExistingLiveDiscoveryRecord): void {
  if (
    typeof record.url !== 'string' ||
    typeof record.instanceNonce !== 'string' ||
    (record.token !== undefined && typeof record.token !== 'string')
  ) {
    throw new Error('Live discovery record is invalid.');
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error('Live discovery URL is invalid.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !loopback ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('Live discovery URL must be a loopback HTTP URL.');
  }
  if (
    !Number.isSafeInteger(record.protocolVersion) ||
    record.protocolVersion <= 0 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !NONCE_PATTERN.test(record.instanceNonce) ||
    (record.token !== undefined &&
      (record.token.length === 0 || record.token.length > 4096))
  ) {
    throw new Error('Live discovery record is invalid.');
  }
}

function assertRecord(record: LiveDiscoveryRecord): void {
  assertSafeRecord(record);
  if (record.protocolVersion !== LIVE_HOST_PROTOCOL_VERSION) {
    throw new Error('Live discovery record is invalid.');
  }
}

function processIsAlive(pid: number): boolean {
  // PID reuse is intentionally fail-closed. The locator has no independent
  // authenticated nonce probe, so a live replacement process must not be
  // mistaken for proof that the recorded daemon is stale.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readExistingRecord(
  filePath: string,
): Promise<ExistingLiveDiscoveryRecord | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    stat.size <= 0 ||
    stat.size > MAX_DISCOVERY_BYTES
  ) {
    throw new Error('Existing Live discovery record is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error('Existing Live discovery record is invalid.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Existing Live discovery record is invalid.');
  }
  const record = parsed as ExistingLiveDiscoveryRecord;
  try {
    assertSafeRecord(record);
  } catch {
    throw new Error('Existing Live discovery record is invalid.');
  }
  return record;
}

async function prepareDirectory(runtimeBaseDir: string): Promise<string> {
  const directory = path.dirname(getLiveDiscoveryPath(runtimeBaseDir));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Live discovery directory is not a regular directory.');
  }
  await fs.chmod(directory, 0o700);
  return directory;
}

export async function writeLiveDiscoveryFile(
  runtimeBaseDir: string,
  record: LiveDiscoveryRecord,
  options: { isProcessAlive?: (pid: number) => boolean } = {},
): Promise<string> {
  assertRecord(record);
  const directory = await prepareDirectory(runtimeBaseDir);
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const temporaryPath = path.join(
    directory,
    `.daemon.${process.pid}.${randomUUID()}.tmp`,
  );
  const release = await lockfile.lock(directory, LOCK_OPTIONS);
  let handle: fs.FileHandle | undefined;
  try {
    const current = await readExistingRecord(filePath);
    if (
      current &&
      (current.pid !== record.pid ||
        current.instanceNonce !== record.instanceNonce) &&
      (options.isProcessAlive ?? processIsAlive)(current.pid)
    ) {
      throw new LiveDiscoveryOwnerActiveError(current.pid);
    }
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_DISCOVERY_BYTES) {
      throw new Error('Live discovery record is too large.');
    }
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
    return filePath;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    await release().catch(() => {});
  }
}

export async function removeLiveDiscoveryFile(
  runtimeBaseDir: string,
  owner: LiveDiscoveryOwner,
): Promise<boolean> {
  if (
    !NONCE_PATTERN.test(owner.instanceNonce) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return false;
  }
  const directory = await prepareDirectory(runtimeBaseDir);
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const release = await lockfile.lock(directory, LOCK_OPTIONS);
  try {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_DISCOVERY_BYTES
    ) {
      return false;
    }
    let current: unknown;
    try {
      current = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return false;
    }
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current) ||
      (current as { instanceNonce?: unknown }).instanceNonce !==
        owner.instanceNonce ||
      (current as { pid?: unknown }).pid !== owner.pid
    ) {
      return false;
    }
    await fs.unlink(filePath);
    return true;
  } finally {
    await release().catch(() => {});
  }
}
