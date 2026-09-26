/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { connect, createServer, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

function connects(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
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
    ['wrong version', JSON.stringify({ ...boot, version: 2 })],
    ['string version', JSON.stringify({ ...boot, version: '1' })],
    ['wrong type', JSON.stringify({ ...boot, type: 'ready' })],
    [
      'missing key',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(boot).filter(([key]) => key !== 'workspaceId'),
        ),
      ),
    ],
    [
      'renamed key',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(boot).map(([key, value]) => [
            key === 'tenantId' ? 'tenant' : key,
            value,
          ]),
        ),
      ),
    ],
    ['null payload', 'null'],
  ])('rejects an invalid boot payload: %s', async (_label, payload) => {
    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([payload])),
    ).rejects.toThrow('Managed Runtime worker boot payload is invalid.');
  });

  it('rejects boot input that is not closed within the startup deadline', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // A plain Readable never ends on its own; the deadline has to destroy it
    // rather than end it.
    const input = new Readable({ read() {} });
    const result = readManagedRuntimeWorkerBoot(input).catch(
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(input.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(
      new Error('Managed Runtime worker boot payload is invalid.'),
    );
    expect(input.destroyed).toBe(true);
    expect(input.readableEnded).toBe(false);
  }, 5_000);

  it('accepts a boot payload of exactly 32 KiB', async () => {
    const serialized = JSON.stringify(boot);
    const payload = serialized.padEnd(32 * 1024, ' ');
    expect(Buffer.byteLength(payload)).toBe(32 * 1024);

    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([payload])),
    ).resolves.toEqual(boot);
  });

  it('rejects a boot payload one byte over 32 KiB split across chunks', async () => {
    // Fake timers keep the startup deadline from firing, and the input never
    // ends, so only the running size count can reject it.
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const serialized = JSON.stringify(boot);
    const input = new Readable({ read() {} });
    input.push(serialized);
    const result = readManagedRuntimeWorkerBoot(input);
    // The reader has already taken the first chunk, so the second arrives as
    // a separate byte chunk, as stdin delivers them.
    expect(
      input.readableLength,
      'precondition: the reader took the first chunk, so the second arrives on its own',
    ).toBe(0);
    input.push(' '.repeat(32 * 1024 + 1 - Buffer.byteLength(serialized)));

    await expect(result).rejects.toThrow(
      'Managed Runtime worker boot payload is invalid.',
    );
    expect(input.destroyed).toBe(true);
  }, 5_000);

  it('does not accept connections on other local addresses', async () => {
    const worker = await startManagedRuntimeAttestationWorker(boot);
    openWorkers.add(worker);
    const port = Number(new URL(worker.ready.url).port);
    expect(await connects('127.0.0.1', port)).toBe(true);

    // Which extra loopback and interface addresses reach a wildcard
    // listener differs by platform, so probe only those that do here.
    const wildcard = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      wildcard.once('error', reject);
      wildcard.listen(0, '0.0.0.0', resolve);
    });
    onTestFinished(
      () => new Promise<void>((resolve) => wildcard.close(() => resolve())),
    );
    const wildcardPort = (wildcard.address() as AddressInfo).port;
    const candidates = [
      '127.0.0.2',
      ...Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address),
    ];
    const answering = async (hosts: string[], target: number) => {
      const answers = await Promise.all(
        hosts.map((host) => connects(host, target)),
      );
      return hosts.filter((_, index) => answers[index]);
    };
    const probes = await answering(candidates, wildcardPort);
    expect(probes).not.toHaveLength(0);

    expect(await answering(probes, port)).toEqual([]);
  });

  it('serves attestation on a loopback listener and rejects unknown routes', async () => {
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
    const listeners = () =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === 'TCPServerWrap').length;
    const before = listeners();

    await expect(
      startManagedRuntimeAttestationWorker({ ...boot, token: '' }),
    ).rejects.toThrow('Managed Runtime attestation identity is invalid.');
    expect(listeners()).toBe(before);
  });

  // ChildProcess.kill() on Windows terminates the process outright: the
  // worker never sees the signal, and Node reports it as killed by that
  // signal with a null exit code.
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'starts through the hidden CLI command and stops on %s',
    async (signal) => {
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
      // Runs even when the test times out, so a worker that ignores the
      // signal is not left behind.
      onTestFinished(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      });
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
      child.kill(signal);
      expect(await exited).toBe(process.platform === 'win32' ? null : 0);
    },
    30_000,
  );
});
