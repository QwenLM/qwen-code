/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

export const LIVE_DISCOVERY_RELATIVE_PATH = path.join('live', 'daemon.json');
const MAX_DISCOVERY_BYTES = 16 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const DEFAULT_HANDOFF_GRACE_MS = 1_000;
const LOCK_OPTIONS: LockOptions = {
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

interface LiveDiscoveryDirectory {
  directory: string;
  dev: number | bigint;
  ino: number | bigint;
}

export class LiveDiscoveryOwnerActiveError extends Error {
  constructor(readonly ownerPid: number) {
    super(`Live discovery is owned by active daemon pid ${ownerPid}.`);
    this.name = 'LiveDiscoveryOwnerActiveError';
  }
}

export class LiveDiscoveryStateError extends Error {
  constructor(cause?: unknown) {
    super('Existing Live discovery record is invalid.', { cause });
    this.name = 'LiveDiscoveryStateError';
  }
}

export class LiveDiscoveryPublicationError extends Error {
  readonly published = true;

  constructor(cause: unknown) {
    super('Live discovery publication completed with cleanup errors.', {
      cause,
    });
    this.name = 'LiveDiscoveryPublicationError';
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
    stat.nlink !== 1 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' &&
          stat.uid !== process.getuid()))) ||
    stat.size <= 0 ||
    stat.size > MAX_DISCOVERY_BYTES
  ) {
    throw new LiveDiscoveryStateError();
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      filePath,
      process.platform === 'win32'
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new LiveDiscoveryStateError(error);
    }
    throw error;
  }
  try {
    const handleStat = await handle.stat();
    if (
      !handleStat.isFile() ||
      handleStat.nlink !== 1 ||
      handleStat.dev !== stat.dev ||
      handleStat.ino !== stat.ino ||
      handleStat.size !== stat.size ||
      (process.platform !== 'win32' &&
        ((handleStat.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === 'function' &&
            handleStat.uid !== process.getuid())))
    ) {
      throw new LiveDiscoveryStateError();
    }
    const serialized = await handle.readFile('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new LiveDiscoveryStateError(error);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new LiveDiscoveryStateError();
    }
    const record = parsed as ExistingLiveDiscoveryRecord;
    try {
      assertSafeRecord(record);
    } catch {
      throw new LiveDiscoveryStateError();
    }
    return record;
  } finally {
    await handle.close();
  }
}

async function inspectDirectory(
  directory: string,
  requirePrivateMode = true,
): Promise<LiveDiscoveryDirectory> {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((requirePrivateMode && (stat.mode & 0o777) !== 0o700) ||
        (typeof process.getuid === 'function' &&
          stat.uid !== process.getuid())))
  ) {
    throw new LiveDiscoveryStateError();
  }
  return { directory, dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(
  expected: LiveDiscoveryDirectory,
  requirePrivateMode = true,
): Promise<void> {
  const current = await inspectDirectory(
    expected.directory,
    requirePrivateMode,
  );
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new LiveDiscoveryStateError();
  }
}

async function ensureDirectory(
  directory: string,
  requirePrivateMode: boolean,
): Promise<LiveDiscoveryDirectory> {
  try {
    return await inspectDirectory(directory, requirePrivateMode);
  } catch (error) {
    try {
      await fs.lstat(directory);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const parent = path.dirname(directory);
  if (parent === directory) throw new LiveDiscoveryStateError();
  const parentIdentity = await ensureDirectory(parent, false);
  await assertDirectoryIdentity(parentIdentity, false);
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created && process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
  }
  await assertDirectoryIdentity(parentIdentity, false);
  return inspectDirectory(directory, requirePrivateMode);
}

async function assertLockShapeIfPresent(lockPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid())
  ) {
    throw new LiveDiscoveryStateError();
  }
}

async function prepareDirectory(
  runtimeBaseDir: string,
  create = true,
): Promise<LiveDiscoveryDirectory | undefined> {
  const directory = path.dirname(getLiveDiscoveryPath(runtimeBaseDir));
  let runtimeBaseIdentity: LiveDiscoveryDirectory;
  try {
    runtimeBaseIdentity = await inspectDirectory(runtimeBaseDir, false);
  } catch (error) {
    try {
      await fs.lstat(runtimeBaseDir);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!create) return undefined;
    runtimeBaseIdentity = await ensureDirectory(runtimeBaseDir, false);
  }
  let created = false;
  try {
    const identity = await inspectDirectory(directory);
    await assertDirectoryIdentity(runtimeBaseIdentity, false);
    return identity;
  } catch (error) {
    try {
      await fs.lstat(directory);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!create) return undefined;
  await assertDirectoryIdentity(runtimeBaseIdentity, false);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created && process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
  }
  await assertDirectoryIdentity(runtimeBaseIdentity, false);
  return inspectDirectory(directory);
}

async function lockDirectory(target: LiveDiscoveryDirectory): Promise<{
  release: () => Promise<void>;
  assertHealthy: () => void;
}> {
  const lockPath = path.join(target.directory, '.daemon.lock');
  await assertLockShapeIfPresent(lockPath);
  const lockfile = (await import('proper-lockfile')).default;
  let compromised = false;
  const release = await lockfile.lock(target.directory, {
    ...LOCK_OPTIONS,
    lockfilePath: lockPath,
    onCompromised: () => {
      compromised = true;
    },
  });
  try {
    await assertLockShapeIfPresent(lockPath);
  } catch (error) {
    let releaseError: unknown;
    await release().catch((candidate: unknown) => {
      releaseError = candidate;
    });
    throw new LiveDiscoveryStateError(
      releaseError
        ? new AggregateError(
            [error, releaseError],
            'Live discovery lock validation cleanup failed.',
          )
        : error,
    );
  }
  return {
    release,
    assertHealthy: () => {
      if (compromised) throw new LiveDiscoveryStateError();
    },
  };
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function handoffLiveDiscoveryOwner(
  runtimeBaseDir: string,
  owner: LiveDiscoveryOwner,
  commitOwner: () => Promise<void>,
  options: {
    isProcessAlive?: (pid: number) => boolean;
    wait?: (milliseconds: number) => Promise<void>;
    handoffGraceMs?: number;
    waitForHandoffGrace?: boolean;
  } = {},
): Promise<{ reclaimed: boolean }> {
  const target = await prepareDirectory(runtimeBaseDir, false);
  if (!target) {
    await commitOwner();
    return { reclaimed: false };
  }
  const lock = await lockDirectory(target);
  let result: { reclaimed: boolean } | undefined;
  let operationError: unknown;
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const filePath = getLiveDiscoveryPath(runtimeBaseDir);
    const current = await readExistingRecord(filePath);
    if (
      current &&
      (current.pid !== owner.pid ||
        current.instanceNonce !== owner.instanceNonce)
    ) {
      if (
        current.pid === owner.pid ||
        (options.isProcessAlive ?? processIsAlive)(current.pid)
      ) {
        throw new LiveDiscoveryOwnerActiveError(current.pid);
      }
      await commitOwner();
      lock.assertHealthy();
      await assertDirectoryIdentity(target);
      const confirmed = await readExistingRecord(filePath);
      if (
        !confirmed ||
        confirmed.pid !== current.pid ||
        confirmed.instanceNonce !== current.instanceNonce
      ) {
        throw new LiveDiscoveryStateError();
      }
      lock.assertHealthy();
      await assertDirectoryIdentity(target);
      await fs.unlink(filePath);
      await syncDirectory(target.directory);
      lock.assertHealthy();
      result = { reclaimed: true };
    } else {
      await commitOwner();
      lock.assertHealthy();
      result = { reclaimed: false };
    }
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  await lock.release().catch((error: unknown) => {
    releaseError = error;
  });
  if (releaseError) {
    throw new LiveDiscoveryStateError(
      operationError
        ? new AggregateError(
            [operationError, releaseError],
            'Live discovery handoff cleanup failed.',
          )
        : releaseError,
    );
  }
  if (operationError) throw operationError;
  if (result?.reclaimed && options.waitForHandoffGrace !== false) {
    await (options.wait ?? delay)(
      options.handoffGraceMs ?? DEFAULT_HANDOFF_GRACE_MS,
    );
  }
  return result!;
}

export async function writeLiveDiscoveryFile(
  runtimeBaseDir: string,
  record: LiveDiscoveryRecord,
  options: { isProcessAlive?: (pid: number) => boolean } = {},
): Promise<string> {
  assertRecord(record);
  const target = await prepareDirectory(runtimeBaseDir);
  if (!target) throw new LiveDiscoveryStateError();
  const { directory } = target;
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const temporaryPath = path.join(
    directory,
    `.daemon.${process.pid}.${randomUUID()}.tmp`,
  );
  const lock = await lockDirectory(target);
  let handle: fs.FileHandle | undefined;
  let operationError: unknown;
  let operationSucceeded = false;
  let published = false;
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const current = await readExistingRecord(filePath);
    if (
      current &&
      (current.pid !== record.pid ||
        current.instanceNonce !== record.instanceNonce)
    ) {
      if ((options.isProcessAlive ?? processIsAlive)(current.pid)) {
        throw new LiveDiscoveryOwnerActiveError(current.pid);
      }
      throw new LiveDiscoveryStateError();
    }
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_DISCOVERY_BYTES) {
      throw new Error('Live discovery record is too large.');
    }
    await handle.writeFile(serialized, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    await fs.rename(temporaryPath, filePath);
    published = true;
    await syncDirectory(directory);
    lock.assertHealthy();
    operationSucceeded = true;
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  await handle?.close().catch((error: unknown) => cleanupErrors.push(error));
  await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') cleanupErrors.push(error);
  });
  await lock.release().catch((error: unknown) => cleanupErrors.push(error));
  if (!operationSucceeded) {
    const cause =
      cleanupErrors.length > 0
        ? new AggregateError(
            [operationError, ...cleanupErrors],
            'Live discovery publication cleanup failed.',
          )
        : operationError;
    if (published) throw new LiveDiscoveryPublicationError(cause);
    if (cleanupErrors.length > 0) {
      throw cause;
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new LiveDiscoveryPublicationError(
      new AggregateError(
        cleanupErrors,
        'Live discovery publication cleanup failed.',
      ),
    );
  }
  return filePath;
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
    throw new LiveDiscoveryStateError();
  }
  const target = await prepareDirectory(runtimeBaseDir, false);
  if (!target) return false;
  const filePath = getLiveDiscoveryPath(runtimeBaseDir);
  const lock = await lockDirectory(target);
  try {
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    const current = await readExistingRecord(filePath);
    if (!current) return false;
    if (
      current.instanceNonce !== owner.instanceNonce ||
      current.pid !== owner.pid
    ) {
      throw new LiveDiscoveryStateError();
    }
    lock.assertHealthy();
    await assertDirectoryIdentity(target);
    await fs.unlink(filePath);
    await syncDirectory(target.directory);
    lock.assertHealthy();
    return true;
  } finally {
    await lock.release();
  }
}
