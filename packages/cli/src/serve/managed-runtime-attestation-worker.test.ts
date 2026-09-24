/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readManagedRuntimeWorkerBoot,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
  type ManagedRuntimeWorkerReady,
} from './managed-runtime-attestation-worker.js';

const boot = Object.freeze({
  type: 'boot',
  version: 1,
  token: 'worker-secret',
  runtimeInstanceId: 'runtime-instance-1',
  runtimeIncarnation: 'runtime-incarnation-1',
  leaseId: 'lease-1',
  epoch: 7,
  provisionRequestId: 'provision-request-1',
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  workspaceGeneration: 'workspace-generation-1',
  workspaceCwd: '/workspace/project',
  capabilityDigest: `sha256:${'a'.repeat(64)}`,
  isolationClass: 'workspace',
} satisfies ManagedRuntimeWorkerBoot);

const openWorkers = new Set<ManagedRuntimeAttestationWorkerHandle>();

afterEach(async () => {
  await Promise.all([...openWorkers].map((worker) => worker.close()));
  openWorkers.clear();
});

function attestationRequest(origin: string): Promise<Response> {
  return fetch(`${origin}/internal/managed-runtime/v2/attest`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${boot.token}`,
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-qwen-managed-lease-id': boot.leaseId,
      'x-qwen-managed-lease-epoch': String(boot.epoch),
    },
    body: JSON.stringify({
      protocolVersion: 2,
      provisionRequestId: boot.provisionRequestId,
      tenantId: boot.tenantId,
      workspaceId: boot.workspaceId,
      workspaceGeneration: boot.workspaceGeneration,
      workspaceCwd: boot.workspaceCwd,
      capabilityDigest: boot.capabilityDigest,
      isolationClass: boot.isolationClass,
    }),
  });
}

async function waitForReady(
  child: ReturnType<typeof spawn>,
): Promise<ManagedRuntimeWorkerReady> {
  return await new Promise<ManagedRuntimeWorkerReady>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Managed Runtime worker did not become ready.')),
      15_000,
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timeout);
      try {
        resolve(
          JSON.parse(stdout.slice(0, newline)) as ManagedRuntimeWorkerReady,
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(
          new Error(`Managed Runtime worker exited ${code}: ${stderr.trim()}`),
        );
      }
    });
  });
}

describe('Managed Runtime attestation worker', () => {
  it('reads one bounded closed boot payload from stdin', async () => {
    const serialized = JSON.stringify(boot);
    const parsed = await readManagedRuntimeWorkerBoot(
      Readable.from([serialized.slice(0, 17), serialized.slice(17)]),
    );

    expect(parsed).toEqual(boot);
  });

  it.each([
    ['malformed JSON', '{'],
    ['unknown field', JSON.stringify({ ...boot, unexpected: true })],
    ['oversized payload', `${JSON.stringify(boot)}${' '.repeat(32 * 1024)}`],
  ])('rejects an invalid boot payload: %s', async (_label, payload) => {
    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([payload])),
    ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
  });

  it('rejects boot input that is not closed within the startup deadline', async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const result = readManagedRuntimeWorkerBoot(input).catch(
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toEqual(
        new Error('Managed Runtime worker boot payload is invalid.'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('mounts only the attestation manifest on a loopback listener', async () => {
    const worker = await startManagedRuntimeAttestationWorker(boot);
    openWorkers.add(worker);

    expect(worker.ready).toEqual({
      type: 'ready',
      version: 1,
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
    });
    expect(worker.ready).not.toHaveProperty('token');

    const response = await attestationRequest(worker.ready.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(await response.json()).toMatchObject({
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
    });

    const unknown = await fetch(`${worker.ready.url}/health`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an invalid identity before opening a listener', async () => {
    await expect(
      startManagedRuntimeAttestationWorker({ ...boot, token: '' }),
    ).rejects.toThrow('Managed Runtime attestation identity is invalid.');
  });

  it('starts through the hidden CLI command and exits cleanly', async () => {
    const cliEntry = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', cliEntry, 'managed-runtime-worker'],
      {
        cwd: packageRoot,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      child.stdin?.end(JSON.stringify(boot));
      const ready = await waitForReady(child);

      expect(ready).toMatchObject({
        type: 'ready',
        version: 1,
        runtimeInstanceId: boot.runtimeInstanceId,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
      });
      expect(await attestationRequest(ready.url)).toHaveProperty('status', 200);

      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', resolve),
      );
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  }, 30_000);
});
