/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core/telemetry/daemon-tracing.js';
import type { ManagedWorkerBoot } from './managed-runtime-activator.js';

const MANAGED_WORKER_BOOT_MAX_BYTES = 32_768;
const MANAGED_WORKER_READY_MAX_BYTES = 8_192;
export const MANAGED_WORKER_BOOT_ENV = 'QWEN_MANAGED_RUNTIME_BOOT';

const IPC_BOOT_KEYS = [
  'type',
  'version',
  'gatewayIncarnation',
  'leaseId',
  'epoch',
  'tenantId',
  'workspaceId',
  'workspaceCwd',
  'token',
  'outputRoot',
  'cliEntry',
] as const;
const FILE_BOOT_KEYS = [
  ...IPC_BOOT_KEYS,
  'runtimeInstanceId',
  'provisionRequestId',
  'workspaceGeneration',
  'capabilityDigest',
  'isolationClass',
] as const;
const REMOTE_FILE_BOOT_KEYS = [
  ...FILE_BOOT_KEYS,
  'listenHostname',
  'listenPort',
] as const;
const FILE_READY_KEYS = [
  'type',
  'version',
  'runtimeInstanceId',
  'gatewayIncarnation',
  'leaseId',
  'epoch',
  'tenantId',
  'workspaceId',
  'workspaceCwd',
  'url',
] as const;

export interface ManagedWorkerFileBoot extends ManagedWorkerBoot {
  readonly runtimeInstanceId: string;
  readonly provisionRequestId: string;
  readonly workspaceGeneration: string;
  readonly capabilityDigest: string;
  readonly isolationClass: 'workspace' | 'session';
  readonly listenHostname?: '0.0.0.0';
  readonly listenPort?: number;
}

interface ManagedWorkerFileReady {
  readonly type: 'ready';
  readonly version: 1;
  readonly runtimeInstanceId: string;
  readonly gatewayIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly url: string;
}

type ManagedWorkerStartup =
  | { readonly kind: 'ipc' }
  | { readonly kind: 'environment' }
  | {
      readonly kind: 'file';
      readonly bootConfigPath: string;
      readonly readyRecordPath: string;
    };

export function parseManagedWorkerStartup(
  argumentsList: readonly string[],
): ManagedWorkerStartup {
  if (argumentsList.length === 0) return { kind: 'ipc' };
  if (argumentsList.length === 1 && argumentsList[0] === '--boot-env') {
    return { kind: 'environment' };
  }
  if (
    argumentsList.length !== 4 ||
    argumentsList[0] !== '--boot-config' ||
    argumentsList[2] !== '--ready-record'
  ) {
    throw new Error('Managed Runtime worker arguments are invalid.');
  }
  const bootConfigPath = argumentsList[1];
  const readyRecordPath = argumentsList[3];
  if (
    !bootConfigPath ||
    !readyRecordPath ||
    !path.isAbsolute(bootConfigPath) ||
    !path.isAbsolute(readyRecordPath)
  ) {
    throw new Error('Managed Runtime worker paths must be absolute.');
  }
  const normalizedBoot = path.resolve(bootConfigPath);
  const normalizedReady = path.resolve(readyRecordPath);
  if (
    normalizedBoot === normalizedReady ||
    path.dirname(normalizedBoot) !== path.dirname(normalizedReady)
  ) {
    throw new Error(
      'Managed Runtime worker files must be distinct and share one directory.',
    );
  }
  return {
    kind: 'file',
    bootConfigPath: normalizedBoot,
    readyRecordPath: normalizedReady,
  };
}

export function readManagedWorkerBootEnvironment(
  environment: NodeJS.ProcessEnv,
): ManagedWorkerFileBoot {
  const raw = environment[MANAGED_WORKER_BOOT_ENV];
  delete environment[MANAGED_WORKER_BOOT_ENV];
  if (!raw || Buffer.byteLength(raw) > MANAGED_WORKER_BOOT_MAX_BYTES) {
    throw new Error('Managed Runtime boot environment is invalid.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Managed Runtime boot environment is invalid.');
  }
  if (
    !isManagedWorkerFileBoot(parsed) ||
    !parsed.listenHostname ||
    parsed.listenPort === undefined
  ) {
    throw new Error('Managed Runtime boot environment is invalid.');
  }
  return parsed;
}

export function isManagedWorkerBoot(
  value: unknown,
): value is ManagedWorkerBoot {
  return validBoot(value, IPC_BOOT_KEYS);
}

function isManagedWorkerFileBoot(
  value: unknown,
): value is ManagedWorkerFileBoot {
  if (validBoot(value, FILE_BOOT_KEYS)) return true;
  if (!validBoot(value, REMOTE_FILE_BOOT_KEYS)) return false;
  const boot = value as unknown as Record<string, unknown>;
  return (
    boot['listenHostname'] === '0.0.0.0' &&
    Number.isSafeInteger(boot['listenPort']) &&
    (boot['listenPort'] as number) > 0 &&
    (boot['listenPort'] as number) <= 65_535
  );
}

export async function readManagedWorkerBootConfig(
  bootConfigPath: string,
): Promise<ManagedWorkerFileBoot> {
  const raw = await readBoundedRegularFile(
    bootConfigPath,
    MANAGED_WORKER_BOOT_MAX_BYTES,
    true,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Managed Runtime boot config is invalid.');
  }
  if (!isManagedWorkerFileBoot(parsed)) {
    throw new Error('Managed Runtime boot config is invalid.');
  }
  return parsed;
}

export async function validateManagedWorkerBootWorkspace(
  boot: ManagedWorkerBoot | ManagedWorkerFileBoot,
): Promise<void> {
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(boot.workspaceCwd);
  } catch {
    throw new Error('Managed Runtime workspace identity is invalid.');
  }
  if (
    canonicalWorkspace !== path.resolve(boot.workspaceCwd) ||
    boot.workspaceId !== hashDaemonWorkspace(canonicalWorkspace)
  ) {
    throw new Error('Managed Runtime workspace identity is invalid.');
  }
}

export function createManagedWorkerReadyRecord(
  boot: ManagedWorkerFileBoot,
  url: string,
): ManagedWorkerFileReady {
  const readyUrl = readyRecordUrl(boot, url);
  return {
    type: 'ready',
    version: 1,
    runtimeInstanceId: boot.runtimeInstanceId,
    gatewayIncarnation: boot.gatewayIncarnation,
    leaseId: boot.leaseId,
    epoch: boot.epoch,
    tenantId: boot.tenantId,
    workspaceId: boot.workspaceId,
    workspaceCwd: boot.workspaceCwd,
    url: readyUrl,
  };
}

export async function writeManagedWorkerReadyRecord(
  readyRecordPath: string,
  ready: ManagedWorkerFileReady,
): Promise<void> {
  if (!isManagedWorkerFileReady(ready)) {
    throw new Error('Managed Runtime ready record is invalid.');
  }
  const bytes = Buffer.from(JSON.stringify(ready));
  if (bytes.byteLength > MANAGED_WORKER_READY_MAX_BYTES) {
    throw new Error('Managed Runtime ready record is too large.');
  }
  try {
    await lstat(readyRecordPath);
    throw new Error('Managed Runtime ready record already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(
    path.dirname(readyRecordPath),
    `.${path.basename(readyRecordPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, readyRecordPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function readManagedWorkerReadyRecord(
  readyRecordPath: string,
  boot: ManagedWorkerFileBoot,
): Promise<ManagedWorkerFileReady> {
  const raw = await readBoundedRegularFile(
    readyRecordPath,
    MANAGED_WORKER_READY_MAX_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Managed Runtime ready record is invalid.');
  }
  if (!isManagedWorkerFileReady(parsed) || !readyMatchesBoot(parsed, boot)) {
    throw new Error('Managed Runtime ready record is invalid.');
  }
  return parsed;
}

function validBoot(
  value: unknown,
  keys: readonly string[],
): value is ManagedWorkerBoot {
  if (
    !isExactRecord(value, keys) ||
    serializedBytes(value) > MANAGED_WORKER_BOOT_MAX_BYTES
  ) {
    return false;
  }
  const boot = value as Record<string, unknown>;
  const strings = [
    'gatewayIncarnation',
    'leaseId',
    'tenantId',
    'workspaceId',
    'workspaceCwd',
    'token',
    'outputRoot',
    'cliEntry',
  ];
  if (keys.includes('runtimeInstanceId')) strings.push('runtimeInstanceId');
  if (keys.includes('provisionRequestId')) {
    strings.push(
      'provisionRequestId',
      'workspaceGeneration',
      'capabilityDigest',
      'isolationClass',
    );
  }
  return (
    boot['type'] === 'boot' &&
    boot['version'] === 1 &&
    Number.isSafeInteger(boot['epoch']) &&
    (boot['epoch'] as number) > 0 &&
    strings.every(
      (key) =>
        typeof boot[key] === 'string' && (boot[key] as string).length > 0,
    ) &&
    (!keys.includes('isolationClass') ||
      boot['isolationClass'] === 'workspace' ||
      boot['isolationClass'] === 'session') &&
    ['workspaceCwd', 'outputRoot', 'cliEntry'].every((key) =>
      path.isAbsolute(boot[key] as string),
    )
  );
}

function isManagedWorkerFileReady(
  value: unknown,
): value is ManagedWorkerFileReady {
  if (!isExactRecord(value, FILE_READY_KEYS)) return false;
  const ready = value as Record<string, unknown>;
  return (
    ready['type'] === 'ready' &&
    ready['version'] === 1 &&
    Number.isSafeInteger(ready['epoch']) &&
    (ready['epoch'] as number) > 0 &&
    [
      'runtimeInstanceId',
      'gatewayIncarnation',
      'leaseId',
      'tenantId',
      'workspaceId',
      'workspaceCwd',
      'url',
    ].every(
      (key) =>
        typeof ready[key] === 'string' && (ready[key] as string).length > 0,
    ) &&
    path.isAbsolute(ready['workspaceCwd'] as string) &&
    validLoopbackOrigin(ready['url'] as string)
  );
}

function readyMatchesBoot(
  ready: ManagedWorkerFileReady,
  boot: ManagedWorkerFileBoot,
): boolean {
  return (
    ready.runtimeInstanceId === boot.runtimeInstanceId &&
    ready.gatewayIncarnation === boot.gatewayIncarnation &&
    ready.leaseId === boot.leaseId &&
    ready.epoch === boot.epoch &&
    ready.tenantId === boot.tenantId &&
    ready.workspaceId === boot.workspaceId &&
    ready.workspaceCwd === boot.workspaceCwd
  );
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  requireOwnerOnly = false,
): Promise<Buffer> {
  const status = await lstat(filePath);
  if (
    !status.isFile() ||
    status.size > maximumBytes ||
    (requireOwnerOnly &&
      process.platform !== 'win32' &&
      (status.mode & 0o077) !== 0)
  ) {
    throw new Error('Managed Runtime handshake file is invalid.');
  }
  const raw = await readFile(filePath);
  if (raw.byteLength > maximumBytes) {
    throw new Error('Managed Runtime handshake file is invalid.');
  }
  return raw;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readyRecordUrl(boot: ManagedWorkerFileBoot, value: string): string {
  if (validLoopbackOrigin(value)) return value;
  if (!boot.listenHostname) {
    throw new Error('Managed Runtime endpoint is invalid.');
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== boot.listenHostname ||
      Number(url.port) !== boot.listenPort ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('Managed Runtime endpoint is invalid.');
    }
    return `http://127.0.0.1:${url.port}`;
  } catch {
    throw new Error('Managed Runtime endpoint is invalid.');
  }
}

function validLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number(url.port) > 0 &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
