/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { Server } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { ManagedCsiMount } from './managed-csi-mount.js';
import {
  MANAGED_CSI_ACK_PATH,
  parseManagedCsiBoot,
  type ManagedCsiPodIdentity,
  type ManagedCsiAckRequest,
} from './managed-csi-envelope.js';
import type { ManagedShellCapturePublisher } from './managed-runtime-tool-executor.js';
import {
  isManagedContextReady,
  type ManagedContextBoot,
} from './managed-context-envelope.js';
import {
  readManagedRuntimeWorkerBoot,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
  type ManagedRuntimeWorkerBoot,
  type ManagedRuntimeWorkerReady,
} from './managed-runtime-attestation-worker.js';
import {
  MANAGED_RUNTIME_LEDGER_ENV,
  ManagedRuntimeLedger,
  testInternals,
} from './managed-runtime-ledger.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';

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

const contextFixtures = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-context-v1.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  boot: ManagedContextBoot;
  attestationCases: Array<{ id: string; body: unknown }>;
};

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

  it('still reads a boot v1 document whose bytes are not all UTF-8', async () => {
    const [before, after] = JSON.stringify({
      ...boot,
      workspaceCwd: '/workspace/X',
    }).split('X');
    const document = Buffer.concat([
      Buffer.from(before!),
      Buffer.from([0xff]),
      Buffer.from(after!),
    ]);

    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([document])),
    ).resolves.toMatchObject({ workspaceCwd: '/workspace/\ufffd' });
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

  it('creates its ledger from the launch environment, arms its watch, and never leaks the path', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'qwen-worker-ledger-'));
    const ledgerFile = path.join(sandbox, 'worker.json');
    const previous = process.env[MANAGED_RUNTIME_LEDGER_ENV];
    const forWorkspace = vi.spyOn(ManagedToolExecutor, 'forWorkspace');
    const watch = vi.spyOn(ManagedRuntimeLedger.prototype, 'watch');
    onTestFinished(async () => {
      forWorkspace.mockRestore();
      watch.mockRestore();
      await worker.close().catch(() => undefined);
      if (previous === undefined) {
        delete process.env[MANAGED_RUNTIME_LEDGER_ENV];
      } else {
        process.env[MANAGED_RUNTIME_LEDGER_ENV] = previous;
      }
      await rm(sandbox, { recursive: true, force: true });
    });
    process.env[MANAGED_RUNTIME_LEDGER_ENV] = ledgerFile;

    const worker = await startManagedRuntimeAttestationWorker(boot);

    expect(forWorkspace).toHaveBeenCalledWith(
      boot.workspaceCwd,
      boot.runtimeInstanceId,
      expect.objectContaining({ ledger: expect.any(ManagedRuntimeLedger) }),
    );
    expect(watch).toHaveBeenCalledTimes(1);
    // The path is for the worker alone: no Shell command inherits the name
    // of the file that accounts for it.
    expect(process.env[MANAGED_RUNTIME_LEDGER_ENV]).toBeUndefined();
    expect(
      testInternals.readLedgerDocument(ledgerFile)?.worker.incarnation,
    ).toBe(boot.runtimeIncarnation);
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

  function spawnWorker(): ReturnType<typeof spawn> {
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
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    return child;
  }

  it('starts with boot v2 through the hidden CLI command', async () => {
    const contextBoot = contextFixtures.boot;
    const child = spawnWorker();
    child.stdin?.end(JSON.stringify(contextBoot));
    const ready = await waitForReady(child);

    expect(isManagedContextReady(ready, contextBoot)).toBe(true);
    const attestation = await fetch(
      `${ready.url}/internal/managed-runtime/v3/attest`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${contextBoot.token}`,
          'cache-control': 'no-store',
          'content-type': 'application/json',
          'x-qwen-managed-lease-id': contextBoot.leaseId,
          'x-qwen-managed-lease-epoch': String(contextBoot.epoch),
        },
        body: JSON.stringify(
          contextFixtures.attestationCases.find(
            (fixture) => fixture.id === 'canonical',
          )!.body,
        ),
      },
    );
    expect(attestation.status).toBe(200);

    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    );
    child.kill('SIGTERM');
    expect(await exited).toBe(process.platform === 'win32' ? null : 0);
  }, 30_000);

  it.each([
    ['boot v2 with an extra key', { ...contextFixtures.boot, extra: true }],
    [
      'boot v2 with a relative mount root',
      { ...contextFixtures.boot, mountRoot: 'mnt' },
    ],
    ['boot v1 marked as version 2', { ...boot, version: 2 }],
  ])(
    'exits before the ready line when it refuses %s',
    async (_label, document) => {
      const child = spawnWorker();
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', resolve),
      );
      child.stdin?.end(JSON.stringify(document));

      expect(await exited).not.toBe(0);
      expect(stdout).toBe('');
    },
    30_000,
  );

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

  it('leaves the environment of a worker started without a channel to its launcher', async () => {
    const cliEntry = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', cliEntry, 'managed-runtime-worker'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          NODE_OPTIONS: '--max-old-space-size=2048',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdin?.end(JSON.stringify(boot));
    await waitForReady(child);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(stderr).not.toContain('scrubbed inherited loader env vars');
  }, 30_000);

  it('stops when the parent that started it with a channel goes away', async () => {
    const cliEntry = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', cliEntry, 'managed-runtime-worker'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          NODE_OPTIONS: '--max-old-space-size=2048',
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      },
    );
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdin?.end(JSON.stringify(boot));
    const ready = await waitForReady(child);
    expect(await attestationRequest(ready.url)).toHaveProperty('status', 200);

    const exited = new Promise<[number | null, string | null]>((resolve) =>
      child.once('exit', (code, signal) => resolve([code, signal])),
    );
    // What the channel's peer sees when the parent ends, however it ends.
    child.disconnect();
    expect(await exited).toEqual([0, null]);
    // The loader vars only booted it; the commands it runs do not see them.
    expect(stderr).toMatch(
      /scrubbed inherited loader env vars from the Managed Runtime worker process;.*NODE_OPTIONS/u,
    );
  }, 30_000);
});

const csiAckFixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-worker-ack-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  boot: unknown;
  expectedPod: ManagedCsiPodIdentity;
  request: ManagedCsiAckRequest;
};

describe('boot-v3 original-worker ACK ownership', () => {
  it.each([false, true])(
    'registers the owned ACK route in the actual boot-v3 startup (capture profile: %s)',
    async (captureProfile) => {
      const boot = parseManagedCsiBoot(csiAckFixture.boot);
      vi.stubEnv('QWEN_POD_UID', csiAckFixture.expectedPod.uid);
      vi.stubEnv('QWEN_POD_NAMESPACE', csiAckFixture.expectedPod.namespace);
      vi.stubEnv('QWEN_NODE_NAME', csiAckFixture.expectedPod.nodeName);
      const observation = vi
        .spyOn(ManagedCsiMount.prototype, 'observe')
        .mockResolvedValue({
          mountId: '1',
          device: '259:8',
          source: '/dev/nvme0n1',
          diskSerial: boot.storage.diskSerial,
          rootDevice: '66312',
          rootInode: '2',
        });
      const prepare = vi.fn(async () => {
        throw new Error('must never prepare');
      });
      const publisher: ManagedShellCapturePublisher | undefined = captureProfile
        ? { prepare }
        : undefined;
      const nativeListen = Server.prototype.listen;
      const listen = vi
        .spyOn(Server.prototype, 'listen')
        .mockImplementation(function (this: Server) {
          return Reflect.apply(nativeListen, this, [0, '127.0.0.1']);
        });
      try {
        const worker = await startManagedRuntimeAttestationWorker(
          boot,
          publisher,
          undefined,
          true,
        );
        openWorkers.add(worker);
        expect(listen).toHaveBeenCalledWith(43190, '0.0.0.0');
        const response = await fetch(worker.ready.url + MANAGED_CSI_ACK_PATH, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + boot.context.token,
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json',
            'X-Qwen-Managed-Lease-Id': boot.context.leaseId,
            'X-Qwen-Managed-Lease-Epoch': String(boot.context.epoch),
          },
          body: JSON.stringify(csiAckFixture.request),
        });
        expect(response.status).toBe(409);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
          code: 'managed_csi_ack_conflict',
          error: 'Managed CSI acknowledgement conflicts.',
        });
        expect(prepare).not.toHaveBeenCalled();
        expect(observation).toHaveBeenCalledTimes(1);
      } finally {
        listen.mockRestore();
        observation.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );
  it('keeps the ACK path unowned for unchanged boot-v2 workers', async () => {
    const worker = await startManagedRuntimeAttestationWorker(
      contextFixtures.boot,
    );
    openWorkers.add(worker);
    const response = await fetch(worker.ready.url + MANAGED_CSI_ACK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(csiAckFixture.request),
    });
    expect(response.status).toBe(404);
  });
});
