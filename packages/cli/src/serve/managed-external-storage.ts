/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  parseManagedContextBoot,
  type ManagedContextBoot,
} from './managed-context-envelope.js';
import { publisherFields } from './managed-shell-publisher.js';
import { realpathDeepestExisting } from './managed-runtime-tool-executor.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

const INVALID = 'Managed Runtime external storage admission failed.';
const directories = new WeakMap<ManagedExternalContextBoot, string>();
const identifier = /^[A-Za-z0-9._-]{1,128}$/;

export interface ManagedExternalStorage {
  readonly kind: 'external';
  readonly physicalKey: string;
  readonly aliasPath: string;
  readonly mountRoot: string;
  readonly registrationRevision: number;
}

export interface ManagedExternalContextBoot extends ManagedContextBoot {
  readonly storage: ManagedExternalStorage;
}

function canonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.startsWith('/') &&
    value !== '/' &&
    path.posix.normalize(value) === value &&
    value
      .slice(1)
      .split('/')
      .every((part) => identifier.test(part) && part !== '.' && part !== '..')
  );
}

function parseStorage(value: unknown): ManagedExternalStorage {
  const storage = publisherFields(value, [
    'kind',
    'physicalKey',
    'aliasPath',
    'mountRoot',
    'registrationRevision',
  ]);
  if (
    storage['kind'] !== 'external' ||
    typeof storage['physicalKey'] !== 'string' ||
    !identifier.test(storage['physicalKey']) ||
    !canonicalPath(storage['aliasPath']) ||
    !canonicalPath(storage['mountRoot']) ||
    !Number.isSafeInteger(storage['registrationRevision']) ||
    (storage['registrationRevision'] as number) < 1
  )
    throw new Error(INVALID);
  return Object.freeze(storage) as unknown as ManagedExternalStorage;
}

async function privateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw new Error(INVALID);
}

/** The adapter supplies this private sibling file from its registration journal. */
export async function readManagedExternalBoot(
  value: unknown,
  bootPath: string,
): Promise<ManagedExternalContextBoot> {
  try {
    const object = value as Record<string, unknown>;
    const { storage: rawStorage, ...context } = object;
    const boot = parseManagedContextBoot(context);
    const storage = parseStorage(rawStorage);
    if (
      boot.isolationClass !== 'session' ||
      boot.mountRoot !== storage.mountRoot ||
      boot.capabilityDigest !== WORKSPACE_CAPABILITY_DIGEST
    )
      throw new Error(INVALID);
    const directory = path.dirname(bootPath);
    if (
      directory === boot.mountRoot ||
      directory.startsWith(boot.mountRoot + '/')
    )
      throw new Error(INVALID);
    await privateDirectory(directory);
    const handle = await open(
      path.join(directory, 'registration.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > 16 * 1024
      )
        throw new Error(INVALID);
      const bytes = Buffer.alloc(16 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16 * 1024) throw new Error(INVALID);
      const registration = publisherFields(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, bytesRead),
          ),
        ),
        [
          'providerId',
          'physicalKey',
          'aliasPath',
          'mountRoot',
          'registrationRevision',
        ],
      );
      // Corresponds to the registration DTO's identity + alias. Provider identity
      // is supplied by the adapter's trusted journal, never inferred from a sandbox.
      if (
        typeof registration['providerId'] !== 'string' ||
        !identifier.test(registration['providerId']) ||
        ['physicalKey', 'aliasPath', 'mountRoot', 'registrationRevision'].some(
          (key) =>
            registration[key] !==
            (storage as unknown as Record<string, unknown>)[key],
        )
      )
        throw new Error(INVALID);
    } finally {
      await handle.close();
    }
    const admitted = Object.freeze({ ...boot, storage });
    directories.set(admitted, directory);
    return admitted;
  } catch {
    throw new Error(INVALID);
  }
}

export async function activateManagedExternalStorage(
  boot: ManagedExternalContextBoot,
): Promise<{
  directory: string;
  verify: () => Promise<void>;
}> {
  try {
    const directory = directories.get(boot);
    if (
      !directory ||
      process.platform === 'win32' ||
      (await realpathDeepestExisting(boot.mountRoot)) !== boot.mountRoot
    )
      throw new Error(INVALID);
    await mkdir(boot.mountRoot, { recursive: true, mode: 0o700 });
    const verify = async () => {
      await privateDirectory(boot.mountRoot);
      await access(
        boot.mountRoot,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
    };
    await verify();
    return { directory, verify };
  } catch {
    throw new Error(INVALID);
  }
}
