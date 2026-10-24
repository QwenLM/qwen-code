/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import lockfile from 'proper-lockfile';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';

export interface ManagedLocalState {
  schemaVersion: 1;
  installationId: string;
  publicToken: string;
  signingKey: string;
  harnessToken: string;
  brokerToken: string;
  writerBindingKey: string;
  runtimeCredentialKey: string;
  capabilityDigest: string;
  javaPort: number;
  harnessPort: number;
  brokerPort: number;
}

const HEX_SECRETS = [
  'publicToken',
  'signingKey',
  'harnessToken',
  'brokerToken',
  'writerBindingKey',
] as const;

export function validateManagedLocalState(value: unknown): ManagedLocalState {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid local state');
  const state = value as Record<string, unknown>;
  if (
    state['schemaVersion'] !== 1 ||
    typeof state['installationId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      state['installationId'],
    ) ||
    HEX_SECRETS.some(
      (key) =>
        typeof state[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(state[key]),
    ) ||
    typeof state['runtimeCredentialKey'] !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(state['runtimeCredentialKey']) ||
    typeof state['capabilityDigest'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(state['capabilityDigest']) ||
    ['javaPort', 'harnessPort', 'brokerPort'].some(
      (key) =>
        !Number.isInteger(state[key]) ||
        Number(state[key]) < 1 ||
        Number(state[key]) > 65535,
    ) ||
    new Set([state['javaPort'], state['harnessPort'], state['brokerPort']])
      .size !== 3
  )
    throw new Error(
      'Invalid local state; restore the original state.json and data together.',
    );
  return value as ManagedLocalState;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Cannot allocate a local service port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function openManagedLocalState(
  directory = path.join(Storage.getGlobalQwenDir(), 'managed-local'),
): Promise<{
  directory: string;
  state: ManagedLocalState;
  release(): Promise<void>;
}> {
  const requested = path.resolve(directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  if ((await lstat(requested)).isSymbolicLink())
    throw new Error('Managed data directory cannot be a symbolic link.');
  const canonical = await realpath(requested);
  for (let ancestor = canonical; ; ancestor = path.dirname(ancestor)) {
    let inGit = false;
    try {
      await access(path.join(ancestor, '.git'));
      inGit = true;
    } catch {
      /* absent */
    }
    if (inGit)
      throw new Error(
        'Managed data must be outside every Git worktree. Use --managed-data-dir outside the project.',
      );
    if (path.dirname(ancestor) === ancestor) break;
  }
  const existing = await readdir(canonical);
  if (
    existing.length &&
    !existing.includes('state.json') &&
    existing.some((entry) => entry !== '.launcher.lock')
  ) {
    throw new Error(
      'Managed data has no state.json; restore the original state and database together.',
    );
  }
  await chmod(canonical, 0o700);
  const release = await lockfile
    .lock(canonical, {
      realpath: true,
      retries: 0,
      stale: 120_000,
      lockfilePath: path.join(canonical, '.launcher.lock'),
    })
    .catch(() => {
      throw new Error(
        'Managed data directory is already in use; stop its launcher before retrying.',
      );
    });
  try {
    const file = path.join(canonical, 'state.json');
    let state: ManagedLocalState;
    const entries = await readdir(canonical);
    if (entries.includes('state.json')) {
      const metadata = await lstat(file);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 16 * 1024 ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error(
          'Managed state.json must be a private regular file (mode 0600).',
        );
      }
      state = validateManagedLocalState(
        JSON.parse(await readFile(file, 'utf8')),
      );
    } else {
      if (entries.some((name) => name !== '.launcher.lock')) {
        throw new Error(
          'Managed data has no state.json; restore the original state and database together.',
        );
      }
      const ports = new Set<number>();
      while (ports.size < 3) ports.add(await freePort());
      const [javaPort, harnessPort, brokerPort] = [...ports] as [
        number,
        number,
        number,
      ];
      const secret = () => randomBytes(32).toString('hex');
      state = {
        schemaVersion: 1,
        installationId: randomUUID(),
        publicToken: secret(),
        signingKey: secret(),
        harnessToken: secret(),
        brokerToken: secret(),
        writerBindingKey: secret(),
        runtimeCredentialKey: randomBytes(32).toString('base64'),
        capabilityDigest: `sha256:${secret()}`,
        javaPort,
        harnessPort,
        brokerPort,
      };
      const temporary = path.join(canonical, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, file);
    }
    for (const child of [
      'database',
      'runtime',
      'worker-home',
      'harness',
      'workspaces',
      'legacy',
      'logs',
    ]) {
      const target = path.join(canonical, child);
      await mkdir(target, { recursive: true, mode: 0o700 });
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`Managed ${child} must be a private directory.`);
      }
      await chmod(target, 0o700);
    }
    return { directory: canonical, state, release };
  } catch (error) {
    await release();
    throw error;
  }
}
