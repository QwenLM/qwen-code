/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readManagedRuntimeContainerBoot,
  runManagedRuntimeAttestationWorker,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';

const directories: string[] = [];
const boot = {
  type: 'boot',
  version: 1,
  token: 'container-private-token',
  runtimeInstanceId: 'runtime',
  runtimeIncarnation: 'incarnation',
  leaseId: 'lease',
  epoch: 1,
  provisionRequestId: 'request',
  tenantId: 'tenant',
  workspaceId: 'workspace',
  workspaceGeneration: '1',
  workspaceCwd: '/workspace',
  capabilityDigest: `sha256:${'a'.repeat(64)}`,
  isolationClass: 'session',
} satisfies ManagedRuntimeWorkerBoot;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function bootFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-container-boot-'));
  directories.push(directory);
  const filename = path.join(directory, 'boot.json');
  await writeFile(filename, contents);
  return filename;
}

describe('Managed Runtime container entry', () => {
  it('reads the closed v1 boot file without changing or removing it', async () => {
    const contents = JSON.stringify(boot);
    const filename = await bootFile(contents);
    expect(await readManagedRuntimeContainerBoot(filename)).toEqual(boot);
    expect(await readFile(filename, 'utf8')).toBe(contents);
  });

  it.each([
    JSON.stringify({ ...boot, isolationClass: 'workspace' }),
    JSON.stringify({ ...boot, version: 2 }),
    JSON.stringify({ ...boot, extra: true }),
    `${JSON.stringify(boot)}${' '.repeat(32 * 1024)}`,
    '{"token":"container-private-token",',
  ])(
    'rejects unsupported or oversized boot without exposing bytes',
    async (contents) => {
      const filename = await bootFile(contents);
      await expect(readManagedRuntimeContainerBoot(filename)).rejects.toThrow(
        /^Managed Runtime worker boot payload is invalid\.$/u,
      );
    },
  );

  it('redacts missing paths and refuses relative boot filenames', async () => {
    for (const filename of [
      '/missing/container-private-token.json',
      'boot.json',
    ]) {
      await expect(readManagedRuntimeContainerBoot(filename)).rejects.toThrow(
        /^Managed Runtime worker boot payload is invalid\.$/u,
      );
    }
  });

  it('opens the explicit container port with authenticated attestation', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    const worker = await startManagedRuntimeAttestationWorker(
      boot,
      undefined,
      undefined,
      true,
    );
    try {
      expect(listen.mock.results[0]?.value?.address()).toMatchObject({
        address: '0.0.0.0',
        port: 43190,
      });
      expect(worker.ready.url).toBe('http://127.0.0.1:43190');
      const url = `${worker.ready.url}/internal/managed-runtime/v2/attest`;
      const body = {
        protocolVersion: 2,
        provisionRequestId: boot.provisionRequestId,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceGeneration: boot.workspaceGeneration,
        workspaceCwd: boot.workspaceCwd,
        capabilityDigest: boot.capabilityDigest,
        isolationClass: boot.isolationClass,
      };
      const headers = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-qwen-managed-lease-id': boot.leaseId,
        'x-qwen-managed-lease-epoch': String(boot.epoch),
      };
      const denied = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(401);
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${boot.token}` },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const proof: unknown = await response.json();
      expect(proof).toMatchObject({
        runtimeInstanceId: boot.runtimeInstanceId,
      });
      expect(JSON.stringify(proof)).not.toContain(boot.token);
    } finally {
      await worker.close();
    }
  });

  it('reports invalid container boot with a redacted error and failing exit code', async () => {
    const savedExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      process.exitCode = undefined;
      await runManagedRuntimeAttestationWorker(
        '/missing/container-private-token.json',
      );
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        'Managed Runtime worker boot payload is invalid.\n',
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('preserves the original stdin failure for the CLI error handler', async () => {
    const originalError = new Error('original stdin failure');
    const savedExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* () {
        yield await Promise.reject(originalError);
      },
    );

    await expect(runManagedRuntimeAttestationWorker(undefined)).rejects.toBe(
      originalError,
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(savedExitCode);
  });

  it('refuses workspace isolation before opening the container listener', async () => {
    await expect(
      startManagedRuntimeAttestationWorker(
        { ...boot, isolationClass: 'workspace' },
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
  });
});
