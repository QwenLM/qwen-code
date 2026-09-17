/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedWorkerReadyRecord,
  isManagedWorkerBoot,
  parseManagedWorkerStartup,
  readManagedWorkerBootConfig,
  readManagedWorkerReadyRecord,
  writeManagedWorkerReadyRecord,
  type ManagedWorkerFileBoot,
} from './managed-runtime-worker-bootstrap.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'managed-worker-bootstrap-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function fileBoot(directory: string): ManagedWorkerFileBoot {
  return {
    type: 'boot',
    version: 1,
    runtimeInstanceId: 'runtime-1',
    gatewayIncarnation: 'broker-1',
    leaseId: 'lease-1',
    epoch: 1,
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    workspaceCwd: path.join(directory, 'workspace'),
    token: 'runtime-token',
    outputRoot: path.join(directory, 'output'),
    cliEntry: path.join(directory, 'cli.js'),
  };
}

describe('managed Runtime worker bootstrap', () => {
  it('keeps IPC mode strict and separate from file mode', async () => {
    const directory = await temporaryDirectory();
    const boot = fileBoot(directory);
    const { runtimeInstanceId: _runtimeInstanceId, ...ipcBoot } = boot;

    expect(isManagedWorkerBoot(ipcBoot)).toBe(true);
    expect(isManagedWorkerBoot(boot)).toBe(false);
    expect(parseManagedWorkerStartup([])).toEqual({ kind: 'ipc' });
    expect(
      parseManagedWorkerStartup([
        '--boot-config',
        path.join(directory, 'boot.json'),
        '--ready-record',
        path.join(directory, 'ready.json'),
      ]),
    ).toEqual({
      kind: 'file',
      bootConfigPath: path.join(directory, 'boot.json'),
      readyRecordPath: path.join(directory, 'ready.json'),
    });
    expect(() =>
      parseManagedWorkerStartup(['--boot-config', 'relative.json']),
    ).toThrow('arguments are invalid');
    expect(() =>
      parseManagedWorkerStartup([
        '--boot-config',
        path.join(directory, 'same.json'),
        '--ready-record',
        path.join(directory, 'same.json'),
      ]),
    ).toThrow('distinct');
  });

  it('reads one bounded exact boot config without accepting extra fields', async () => {
    const directory = await temporaryDirectory();
    const bootPath = path.join(directory, 'boot.json');
    const boot = fileBoot(directory);
    await writeFile(bootPath, JSON.stringify(boot), { mode: 0o600 });

    await expect(readManagedWorkerBootConfig(bootPath)).resolves.toEqual(boot);
    await writeFile(bootPath, JSON.stringify({ ...boot, extra: true }));
    await expect(readManagedWorkerBootConfig(bootPath)).rejects.toThrow(
      'boot config is invalid',
    );
    await writeFile(bootPath, 'x'.repeat(32_769));
    await expect(readManagedWorkerBootConfig(bootPath)).rejects.toThrow(
      'handshake file is invalid',
    );
    if (process.platform !== 'win32') {
      await writeFile(bootPath, JSON.stringify(boot));
      await chmod(bootPath, 0o644);
      await expect(readManagedWorkerBootConfig(bootPath)).rejects.toThrow(
        'handshake file is invalid',
      );
    }
  });

  it('publishes an owner-only atomic ready record without the token', async () => {
    const directory = await temporaryDirectory();
    const readyPath = path.join(directory, 'ready.json');
    const boot = fileBoot(directory);
    const ready = createManagedWorkerReadyRecord(boot, 'http://127.0.0.1:4183');

    await writeManagedWorkerReadyRecord(readyPath, ready);

    await expect(
      readManagedWorkerReadyRecord(readyPath, boot),
    ).resolves.toEqual(ready);
    const raw = await readFile(readyPath, 'utf8');
    expect(raw).not.toContain(boot.token);
    if (process.platform !== 'win32') {
      expect((await stat(readyPath)).mode & 0o777).toBe(0o600);
    }
    await expect(
      writeManagedWorkerReadyRecord(readyPath, ready),
    ).rejects.toThrow('already exists');
  });

  it('rejects mismatched identities and non-loopback endpoint shapes', async () => {
    const directory = await temporaryDirectory();
    const readyPath = path.join(directory, 'ready.json');
    const boot = fileBoot(directory);
    const ready = createManagedWorkerReadyRecord(boot, 'http://127.0.0.1:4183');
    await writeFile(
      readyPath,
      JSON.stringify({ ...ready, runtimeInstanceId: 'other-runtime' }),
    );

    await expect(readManagedWorkerReadyRecord(readyPath, boot)).rejects.toThrow(
      'ready record is invalid',
    );
    expect(() =>
      createManagedWorkerReadyRecord(boot, 'http://localhost:4183'),
    ).toThrow('endpoint is invalid');
    expect(() =>
      createManagedWorkerReadyRecord(boot, 'http://127.0.0.1:4183/path'),
    ).toThrow('endpoint is invalid');
    expect(() =>
      createManagedWorkerReadyRecord(boot, 'http://127.0.0.1:0'),
    ).toThrow('endpoint is invalid');
  });

  it('treats cyclic IPC input as invalid instead of throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(isManagedWorkerBoot(value)).toBe(false);
  });
});
