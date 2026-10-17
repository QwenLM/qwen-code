/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getCliVersion } from '../utils/version.js';
import {
  createManagedContextAttestationResponse,
  isManagedContextReady,
  parseManagedContextBoot,
  type ManagedContextBoot,
  type ManagedContextReady,
} from './managed-context-envelope.js';

const MARKER = '.qwen-managed-storage.json';
const MAX_BYTES = 64 * 1024;
const ID = /^[a-zA-Z0-9_.:-]{1,512}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let hostId: string | undefined;
export const SSH_RETIRE_PATH = '/internal/managed-runtime/v3/retire';

export interface SshStorageIdentity {
  readonly root: string;
  readonly hostId: string;
  readonly device: string;
  readonly inode: string;
  readonly birthTime: string;
}

export interface SshStorageMarker extends SshStorageIdentity {
  readonly version: 2;
  readonly tenantId: string;
  readonly storageId: string;
  readonly registrationId: string;
}

export interface SshRuntimeRecord {
  readonly version: 1;
  readonly nodeId: string;
  readonly stateDirectory: string;
  readonly resourceId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly boot: ManagedContextBoot;
  readonly identity: SshStorageIdentity;
  readonly marker: SshStorageMarker;
  readonly workerEntry: string;
  readonly expectedQwenVersion: string;
}

export interface SshRuntimeCleanProof {
  readonly version: 1;
  readonly resourceId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly provisionRequestId: string;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly retirementId: string;
  readonly retiredAt: string;
}

export class SshBootstrapError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function refuse(message: string): never {
  throw new SshBootstrapError('ssh_runtime_identity_conflict', message);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return refuse('Runtime bootstrap document is invalid.');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    return refuse('Runtime bootstrap text is invalid.');
  return value;
}

function absolute(value: unknown): string {
  const directory = text(value);
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
    return refuse('Runtime path must be absolute and normalized.');
  return directory;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !(field in value))
  )
    refuse('Runtime bootstrap document has unexpected fields.');
}

export async function readSshPrivateJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.size > MAX_BYTES ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    refuse('Runtime state file is not owner-private.');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function syncParentDirectory(file: string): Promise<void> {
  const directory = await fs.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeSshPrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  if (
    !(await createSshPrivateJson(file, value)) &&
    !isDeepStrictEqual(await readSshPrivateJson(file), value)
  )
    refuse('Runtime state conflicts with an earlier operation.');
}

async function createSshPrivateJson(
  file: string,
  value: unknown,
): Promise<boolean> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, 'wx', 0o600);
  let created = true;
  try {
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      created = false;
    }
  } finally {
    await fs.unlink(temporary);
  }
  await syncParentDirectory(file);
  return created;
}

async function privateDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    (await fs.realpath(directory)) !== directory ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    refuse('Runtime state directory must be canonical and owner-private.');
  for (let current = directory; ; current = path.dirname(current)) {
    await syncParentDirectory(current);
    if (created === undefined || current === created) break;
  }
}

function identityDocument(value: unknown): SshStorageIdentity {
  const identity = object(value);
  exact(identity, ['root', 'hostId', 'device', 'inode', 'birthTime']);
  absolute(identity['root']);
  if (
    !/^[0-9a-f]{64}$/.test(text(identity['hostId'])) ||
    !/^\d+$/.test(text(identity['device'])) ||
    !/^\d+$/.test(text(identity['inode'])) ||
    !Number.isFinite(Date.parse(text(identity['birthTime'])))
  )
    refuse('Storage identity is invalid.');
  return identity as unknown as SshStorageIdentity;
}

function markerDocument(
  value: unknown,
  identity: SshStorageIdentity,
): SshStorageMarker {
  const marker = object(value);
  exact(marker, [
    'version',
    'tenantId',
    'storageId',
    'root',
    'hostId',
    'device',
    'inode',
    'birthTime',
    'registrationId',
  ]);
  if (
    marker['version'] !== 2 ||
    !UUID.test(text(marker['registrationId'])) ||
    !ID.test(text(marker['tenantId'])) ||
    !ID.test(text(marker['storageId'])) ||
    Object.entries(identity).some(([key, item]) => marker[key] !== item)
  )
    refuse('Storage marker does not bind the registered identity.');
  return marker as unknown as SshStorageMarker;
}

export async function inspectSshStorage(
  root: string,
): Promise<SshStorageIdentity> {
  if (!['linux', 'darwin'].includes(process.platform))
    throw new SshBootstrapError(
      'ssh_runtime_platform_unsupported',
      'Runtime requires Linux or macOS.',
    );
  if (absolute(root) !== (await fs.realpath(root)))
    refuse('Storage root is not canonical.');
  const stat = await fs.lstat(root, { bigint: true });
  // Birth and modification times can legitimately match for an empty directory.
  if (!stat.isDirectory() || stat.birthtimeNs <= 0n)
    refuse('Storage directory has no independent birth identity.');
  await fs.access(root, constants.R_OK | constants.W_OK | constants.X_OK);
  const machine = hostId
    ? undefined
    : process.platform === 'linux'
      ? (await fs.readFile('/etc/machine-id', 'utf8')).trim()
      : /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(
          execFileSync(
            '/usr/sbin/ioreg',
            ['-rd1', '-c', 'IOPlatformExpertDevice'],
            { encoding: 'utf8', timeout: 5_000, maxBuffer: MAX_BYTES },
          ),
        )?.[1];
  if (!hostId) {
    if (!machine || machine.length > 256)
      refuse('Stable host identity is unavailable.');
    hostId = createHmac('sha256', machine)
      .update('Qwen-Code/verified-workspace/v2')
      .digest('hex');
  }
  const seconds = stat.birthtimeNs / 1_000_000_000n;
  const nanos = (stat.birthtimeNs % 1_000_000_000n).toString().padStart(9, '0');
  const fraction =
    nanos === '000000000'
      ? ''
      : `.${nanos.endsWith('000000') ? nanos.slice(0, 3) : nanos.endsWith('000') ? nanos.slice(0, 6) : nanos}`;
  return {
    root,
    hostId,
    device: BigInt.asUintN(64, stat.dev).toString(),
    inode: BigInt.asUintN(64, stat.ino).toString(),
    birthTime: new Date(Number(seconds) * 1000)
      .toISOString()
      .replace(/\.000Z$/, `${fraction}Z`),
  };
}

export async function verifySshStorage(
  identity: SshStorageIdentity,
  marker?: SshStorageMarker,
): Promise<void> {
  if (!isDeepStrictEqual(await inspectSshStorage(identity.root), identity))
    refuse('Registered storage identity changed.');
  if (
    marker &&
    !isDeepStrictEqual(
      await readSshPrivateJson(path.join(identity.root, MARKER)),
      marker,
    )
  )
    refuse('Registered storage marker changed.');
}

function resourceDirectory(stateDirectory: string, resourceId: string): string {
  if (!UUID.test(resourceId)) refuse('Runtime resource identity is invalid.');
  return path.join(stateDirectory, 'resources', resourceId);
}

export async function readSshRuntimeRecord(
  directory: string,
): Promise<SshRuntimeRecord> {
  const value = object(
    await readSshPrivateJson(path.join(directory, 'intent.json')),
  );
  exact(value, [
    'version',
    'nodeId',
    'stateDirectory',
    'resourceId',
    'bindingId',
    'bindingGeneration',
    'boot',
    'identity',
    'marker',
    'workerEntry',
    'expectedQwenVersion',
  ]);
  const identity = identityDocument(value['identity']);
  const boot = parseManagedContextBoot(value['boot']);
  const marker = markerDocument(value['marker'], identity);
  if (
    value['version'] !== 1 ||
    !ID.test(text(value['nodeId'])) ||
    !ID.test(text(value['bindingId'])) ||
    !Number.isSafeInteger(value['bindingGeneration']) ||
    Number(value['bindingGeneration']) <= 0 ||
    boot.isolationClass !== 'session' ||
    boot.mountRoot !== identity.root ||
    boot.tenantId !== marker.tenantId ||
    boot.storageId !== marker.storageId ||
    resourceDirectory(
      absolute(value['stateDirectory']),
      text(value['resourceId']),
    ) !== directory
  )
    refuse('Runtime intent identity is invalid.');
  absolute(value['workerEntry']);
  text(value['expectedQwenVersion']);
  return value as unknown as SshRuntimeRecord;
}

export function sshCleanProof(
  record: SshRuntimeRecord,
  retirementId: string,
  retiredAt: string,
): SshRuntimeCleanProof {
  return {
    version: 1,
    resourceId: record.resourceId,
    bindingId: record.bindingId,
    bindingGeneration: record.bindingGeneration,
    provisionRequestId: record.boot.provisionRequestId,
    runtimeInstanceId: record.boot.runtimeInstanceId,
    runtimeIncarnation: record.boot.runtimeIncarnation,
    leaseId: record.boot.leaseId,
    epoch: record.boot.epoch,
    retirementId,
    retiredAt,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new SshBootstrapError(
      'ssh_runtime_stop_unverified',
      'Original process liveness is unverified.',
    );
  }
}

async function optionalJson(file: string): Promise<unknown | undefined> {
  try {
    return await readSshPrivateJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function observe(
  record: SshRuntimeRecord,
): Promise<Record<string, unknown>> {
  await verifySshStorage(record.identity, record.marker);
  const directory = resourceDirectory(record.stateDirectory, record.resourceId);
  const pidRecord = await optionalJson(path.join(directory, 'pid.json'));
  const pid = pidRecord === undefined ? null : object(pidRecord)['pid'];
  if (pid !== null && (!Number.isSafeInteger(pid) || Number(pid) <= 1))
    refuse('Runtime process record is invalid.');
  const result: Record<string, unknown> = {
    resourceId: record.resourceId,
    state: 'INTENT',
    pid,
    ready: null,
  };
  const claim = await optionalJson(path.join(directory, 'launch.claim'));
  if (claim === undefined) {
    for (const file of [
      'pid.json',
      'ready.json',
      'clean.json',
      'stdout.log',
      'stderr.log',
      'launch-failed.json',
    ]) {
      try {
        await fs.lstat(path.join(directory, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      refuse('Runtime launch claim is missing from an existing resource.');
    }
    return result;
  }
  const claimedRetirement = object(claim)['retirementId'];
  const neverStarted =
    typeof claimedRetirement === 'string' && UUID.test(claimedRetirement);
  if (
    !isDeepStrictEqual(
      claim,
      neverStarted
        ? {
            provisionRequestId: record.boot.provisionRequestId,
            retirementId: claimedRetirement,
          }
        : { provisionRequestId: record.boot.provisionRequestId },
    )
  )
    refuse('Runtime launch claim conflicts.');
  if (neverStarted && pid !== null)
    refuse('A retired launch claim cannot own a worker process.');
  const failed = await optionalJson(path.join(directory, 'launch-failed.json'));
  if (
    failed !== undefined &&
    (!isDeepStrictEqual(failed, {
      provisionRequestId: record.boot.provisionRequestId,
    }) ||
      pid !== null ||
      (await optionalJson(path.join(directory, 'ready.json'))) !== undefined)
  )
    refuse('Runtime failed-launch evidence conflicts.');
  const clean = await optionalJson(path.join(directory, 'clean.json'));
  if (clean !== undefined) {
    const proof = object(clean);
    const retiredAt = text(proof['retiredAt']);
    const stop = object(
      await readSshPrivateJson(path.join(directory, 'stop.json')),
    );
    if (
      !Number.isFinite(Date.parse(retiredAt)) ||
      !isDeepStrictEqual(
        clean,
        sshCleanProof(record, text(stop['retirementId']), retiredAt),
      )
    )
      refuse('Runtime clean proof conflicts.');
    if (
      ((neverStarted || failed !== undefined) &&
        pid === null &&
        (failed !== undefined || claimedRetirement === stop['retirementId'])) ||
      (pid !== null && !alive(Number(pid)))
    )
      return { ...result, state: 'RETIRED', cleanProof: clean };
    return { ...result, state: 'BLOCKED' };
  }
  if (failed !== undefined) return { ...result, state: 'FAILED' };
  if (neverStarted && pid === null) return result;
  if (pid === null || !alive(Number(pid)))
    return { ...result, state: 'BLOCKED' };
  const ready = await optionalJson(path.join(directory, 'ready.json'));
  if (ready === undefined) return { ...result, state: 'STARTING' };
  const value = object(ready);
  if (!isManagedContextReady(value, record.boot))
    refuse('Runtime ready identity conflicts.');
  return { ...result, state: 'READY', ready: value };
}

async function attest(
  record: SshRuntimeRecord,
  ready: ManagedContextReady,
): Promise<void> {
  const expected = createManagedContextAttestationResponse(record.boot);
  const {
    runtimeInstanceId: _runtime,
    runtimeIncarnation: _incarnation,
    leaseId: _lease,
    epoch: _epoch,
    ...request
  } = expected;
  const response = await fetch(
    `${ready.url}/internal/managed-runtime/v3/attest`,
    {
      method: 'POST',
      headers: sshRuntimeHeaders(record.boot),
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok || !isDeepStrictEqual(await response.json(), expected))
    refuse('Original Runtime attestation failed.');
}

export function sshRuntimeHeaders(
  boot: ManagedContextBoot,
): Record<string, string> {
  return {
    Authorization: `Bearer ${boot.token}`,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Qwen-Managed-Lease-Id': boot.leaseId,
    'X-Qwen-Managed-Lease-Epoch': String(boot.epoch),
  };
}

async function ensure(
  request: Record<string, unknown>,
  nodeId: string,
  stateDirectory: string,
): Promise<Record<string, unknown>> {
  const resourceId = text(request['resourceId']);
  const expectedQwenVersion = text(request['expectedQwenVersion']);
  if (expectedQwenVersion !== (await getCliVersion())) {
    throw new SshBootstrapError(
      'ssh_runtime_version_conflict',
      'Pinned Qwen version does not match this installation.',
    );
  }
  const directory = resourceDirectory(stateDirectory, resourceId);
  const identity = identityDocument(request['identity']);
  const marker = markerDocument(request['marker'], identity);
  if (
    within(identity.root, stateDirectory) ||
    within(stateDirectory, identity.root)
  )
    refuse('Runtime state and Workspace roots must not overlap.');
  await verifySshStorage(identity, marker);
  await privateDirectory(directory);
  const record = {
    version: 1,
    nodeId,
    stateDirectory,
    resourceId,
    bindingId: request['bindingId'],
    bindingGeneration: request['bindingGeneration'],
    boot: request['boot'],
    identity,
    marker,
    workerEntry: absolute(request['workerEntry']),
    expectedQwenVersion,
  };
  await writeSshPrivateJson(path.join(directory, 'intent.json'), record);
  const saved = await readSshRuntimeRecord(directory);
  if (typeof request['launch'] !== 'boolean')
    refuse('Runtime launch phase is required.');
  if (!request['launch']) return observe(saved);
  if ((await optionalJson(path.join(directory, 'stop.json'))) !== undefined)
    return observe(saved);
  const original = await observe(saved);
  if (original['state'] !== 'INTENT') return original;
  if (
    !(await createSshPrivateJson(path.join(directory, 'launch.claim'), {
      provisionRequestId: saved.boot.provisionRequestId,
    }))
  )
    return observe(saved);
  let spawned = false;
  try {
    const output = await fs.open(
      path.join(directory, 'stdout.log'),
      'ax',
      0o600,
    );
    try {
      const errors = await fs.open(
        path.join(directory, 'stderr.log'),
        'ax',
        0o600,
      );
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const key of [
          'PATH',
          'HOME',
          'USER',
          'LOGNAME',
          'SHELL',
          'LANG',
          'LC_ALL',
          'TMPDIR',
          'TMP',
          'TEMP',
          'TZ',
        ]) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        const child = spawn(
          process.execPath,
          [saved.workerEntry, 'managed-runtime-bootstrap-worker', directory],
          {
            cwd: path.dirname(saved.workerEntry),
            detached: true,
            stdio: ['ignore', output.fd, errors.fd],
            env,
          },
        );
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        spawned = true;
        child.unref();
        await writeSshPrivateJson(path.join(directory, 'pid.json'), {
          pid: child.pid,
        });
      } finally {
        await errors.close();
      }
    } finally {
      await output.close();
    }
  } catch {
    if (!spawned) {
      await writeSshPrivateJson(path.join(directory, 'launch-failed.json'), {
        provisionRequestId: saved.boot.provisionRequestId,
      });
      return observe(saved);
    }
    // The original worker also publishes its PID; never launch a replacement.
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await observe(saved);
    if (
      observed['state'] !== 'STARTING' &&
      !(observed['state'] === 'BLOCKED' && observed['pid'] === null)
    )
      return observed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return observe(saved);
}

export async function executeSshBootstrap(
  value: unknown,
): Promise<Record<string, unknown>> {
  const request = object(value);
  if (request['protocolVersion'] !== 1 || !ID.test(text(request['nodeId'])))
    refuse('Runtime bootstrap protocol is invalid.');
  const nodeId = text(request['nodeId']);
  const stateDirectory = absolute(request['stateDirectory']);
  const operation = text(request['operation']);
  if (operation === 'probe' || operation === 'ensure') {
    if (Number(process.versions.node.split('.')[0]) < 22) {
      throw new SshBootstrapError(
        'ssh_runtime_node_unsupported',
        'Runtime requires Node.js 22 or later.',
      );
    }
  }
  if (operation === 'probe') {
    const root = absolute(request['root']);
    const roots = request['allowedRoots'];
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      !roots.some((candidate) => within(absolute(candidate), root))
    )
      refuse('Directory is outside the configured roots.');
    if (within(root, stateDirectory) || within(stateDirectory, root))
      refuse('Runtime state and Workspace roots must not overlap.');
    const identity = await inspectSshStorage(root);
    if (request['cwdRelative'] !== undefined) {
      const relative = text(request['cwdRelative']);
      const cwd = path.resolve(root, relative);
      if (
        path.isAbsolute(relative) ||
        !within(root, cwd) ||
        cwd !== (await fs.realpath(cwd)) ||
        !(await fs.stat(cwd)).isDirectory()
      )
        refuse('Working directory is unavailable.');
      await fs.access(cwd, constants.R_OK | constants.W_OK | constants.X_OK);
    }
    return {
      platform: process.platform,
      nodeVersion: process.version,
      qwenVersion: await getCliVersion(),
      identity,
      marker: (await optionalJson(path.join(root, MARKER))) ?? null,
    };
  }
  if (operation === 'register-storage') {
    const identity = identityDocument(request['identity']);
    const marker = markerDocument(request['marker'], identity);
    if (
      within(identity.root, stateDirectory) ||
      within(stateDirectory, identity.root)
    )
      refuse('Runtime state and Workspace roots must not overlap.');
    await verifySshStorage(identity);
    await writeSshPrivateJson(path.join(identity.root, MARKER), marker);
    await verifySshStorage(identity, marker);
    return { identity, marker };
  }
  await privateDirectory(stateDirectory);
  if (operation === 'ensure') return ensure(request, nodeId, stateDirectory);
  const directory = resourceDirectory(
    stateDirectory,
    text(request['resourceId']),
  );
  const record = await readSshRuntimeRecord(directory);
  if (record.nodeId !== nodeId || record.stateDirectory !== stateDirectory)
    refuse('Runtime node identity conflicts.');
  let observed = await observe(record);
  if (operation === 'observe') return observed;
  if (operation !== 'stop')
    refuse('Runtime bootstrap operation is unsupported.');
  const retirementId = text(request['retirementId']);
  if (!UUID.test(retirementId))
    refuse('Runtime retirement identity is invalid.');
  if (observed['state'] === 'INTENT') {
    await createSshPrivateJson(path.join(directory, 'launch.claim'), {
      provisionRequestId: record.boot.provisionRequestId,
      retirementId,
    });
    observed = await observe(record);
  }
  const claim = object(
    await readSshPrivateJson(path.join(directory, 'launch.claim')),
  );
  if (
    claim['retirementId'] !== undefined &&
    claim['retirementId'] !== retirementId
  )
    refuse('Runtime retirement identity conflicts.');
  if (observed['state'] === 'RETIRED') {
    await writeSshPrivateJson(path.join(directory, 'stop.json'), {
      retirementId,
    });
    return observed;
  }
  if (
    observed['state'] === 'FAILED' ||
    claim['retirementId'] === retirementId
  ) {
    await writeSshPrivateJson(path.join(directory, 'stop.json'), {
      retirementId,
    });
    await verifySshStorage(record.identity, record.marker);
    await writeSshPrivateJson(
      path.join(directory, 'clean.json'),
      sshCleanProof(record, retirementId, new Date().toISOString()),
    );
    return observe(record);
  }
  if (
    observed['state'] === 'STARTING' ||
    (observed['state'] === 'BLOCKED' && observed['pid'] === null)
  )
    throw new SshBootstrapError(
      'ssh_runtime_retirement_pending',
      'Original Runtime startup has not completed.',
      true,
    );
  if (observed['state'] !== 'READY')
    throw new SshBootstrapError(
      'ssh_runtime_stop_unverified',
      'Original Runtime is not reachable for clean retirement.',
    );
  await writeSshPrivateJson(path.join(directory, 'stop.json'), {
    retirementId,
  });
  const ready = observed['ready'] as ManagedContextReady;
  try {
    await attest(record, ready);
    const response = await fetch(`${ready.url}${SSH_RETIRE_PATH}`, {
      method: 'POST',
      headers: sshRuntimeHeaders(record.boot),
      body: JSON.stringify({
        protocolVersion: 1,
        resourceId: record.resourceId,
        retirementId,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new SshBootstrapError(
        'ssh_runtime_retirement_pending',
        'Original Runtime retirement is not proven.',
        true,
      );
    await response.arrayBuffer();
  } catch (error) {
    if (error instanceof SshBootstrapError) throw error;
    // A response can be lost after the worker wrote its proof and exited.
    if ((await observe(record))['state'] !== 'RETIRED')
      throw new SshBootstrapError(
        'ssh_runtime_retirement_pending',
        'Original Runtime retirement response is unavailable.',
        true,
      );
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await observe(record);
    if (result['state'] === 'RETIRED') return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SshBootstrapError(
    'ssh_runtime_stop_unverified',
    'Original Runtime process has not exited.',
    true,
  );
}

export async function runManagedRuntimeBootstrap(): Promise<void> {
  let response;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > MAX_BYTES)
        refuse('Runtime bootstrap request exceeds its limit.');
      chunks.push(bytes);
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    response = {
      protocolVersion: 1,
      ok: true,
      result: await executeSshBootstrap(JSON.parse(source) as unknown),
    };
  } catch (error) {
    const known =
      error instanceof SshBootstrapError
        ? error
        : new SshBootstrapError(
            'ssh_runtime_state_unavailable',
            'Runtime bootstrap state is unavailable.',
          );
    response = {
      protocolVersion: 1,
      ok: false,
      error: {
        code: known.code,
        message: known.message,
        retryable: known.retryable,
      },
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export function sshResourcePath(record: SshRuntimeRecord): string {
  return resourceDirectory(record.stateDirectory, record.resourceId);
}
