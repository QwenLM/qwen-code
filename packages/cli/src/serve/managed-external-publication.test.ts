/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'node:http';
import { ShellExecutionService } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import { ManagedExternalPublication } from './managed-external-publication.js';
import {
  readManagedExternalBoot,
  activateManagedExternalStorage,
  type ManagedExternalContextBoot,
} from './managed-external-storage.js';
import {
  readManagedRuntimeContainerBoot,
  startManagedRuntimeAttestationWorker,
} from './managed-runtime-attestation-worker.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ManagedRuntimeLedger } from './managed-runtime-ledger.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

let root: string;
let boot: ManagedExternalContextBoot;
let publication: ManagedExternalPublication | undefined;
const closers: Array<() => Promise<void>> = [];
const request = {
  reference: {
    sessionId: 'runtime-session-a',
    promptId: 'prompt-a',
    callId: 'call-a',
    argsDigest: 'a'.repeat(64),
  },
  capture: {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    executionCallId: 'execution-a',
    bindingGeneration: '1',
    capturePolicy: 'complete_required' as const,
  },
};

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'external-worker-')),
  );
  boot = {
    type: 'boot',
    version: 2,
    managedContext: 'managed-context/1',
    token: 'private-boot-token',
    leaseId: 'lease-a',
    epoch: 1,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    workspaceGeneration: '1',
    runtimeInstanceId: 'runtime-a',
    runtimeIncarnation: 'incarnation-a',
    provisionRequestId: 'provision-a',
    isolationClass: 'session',
    capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
    storageId: 'external-storage-a',
    mountRoot: path.join(root, 'workspace'),
    storage: {
      kind: 'external',
      physicalKey: 'physical-a',
      aliasPath: '/external/workspace-a',
      mountRoot: path.join(root, 'workspace'),
      registrationRevision: 1,
    },
  };
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await publication?.close();
  publication = undefined;
  vi.restoreAllMocks();
  // root is the canonical mkdtemp path allocated by this test.
  await fs.rm(root, { recursive: true, force: true });
});

async function descriptor(overrides: Record<string, unknown> = {}) {
  const { kind: _, ...storage } = boot.storage;
  await fs.writeFile(
    path.join(root, 'registration.json'),
    JSON.stringify({ providerId: 'external-a', ...storage, ...overrides }),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(root, 'boot.json'), JSON.stringify(boot), {
    mode: 0o600,
  });
}

async function admitted() {
  await descriptor();
  return readManagedExternalBoot(boot, path.join(root, 'boot.json'));
}

describe.skipIf(process.platform === 'win32')('external boot admission', () => {
  it('admits a registered container boot, creates a private mount and keeps bare v2 rejected', async () => {
    await descriptor();
    const parsed = await readManagedRuntimeContainerBoot(
      path.join(root, 'boot.json'),
    );
    expect(parsed).toEqual(boot);
    const mounted = await activateManagedExternalStorage(
      parsed as ManagedExternalContextBoot,
    );
    await mounted.verify();
    expect((await fs.stat(boot.mountRoot)).mode & 0o777).toBe(0o700);
    await expect(activateManagedExternalStorage(boot)).rejects.toThrow(
      'admission failed',
    );
    const { storage: _, ...bare } = boot;
    await fs.writeFile(path.join(root, 'boot.json'), JSON.stringify(bare));
    await expect(
      readManagedRuntimeContainerBoot(path.join(root, 'boot.json')),
    ).rejects.toThrow('boot payload is invalid');
  });

  it.each(['physicalKey', 'aliasPath', 'mountRoot', 'registrationRevision'])(
    'rejects a mismatched registration %s without creating a mount',
    async (key) => {
      await descriptor({
        [key]: key === 'registrationRevision' ? 2 : 'different',
      });
      await expect(
        readManagedRuntimeContainerBoot(path.join(root, 'boot.json')),
      ).rejects.toThrow('boot payload is invalid');
      await expect(fs.stat(boot.mountRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.each(['/', '/a/../b', '/a//b', '/a/./b', '/a/', 'relative'])(
    'rejects noncanonical mount %s',
    async (mountRoot) => {
      boot = { ...boot, mountRoot, storage: { ...boot.storage, mountRoot } };
      await descriptor();
      await expect(
        readManagedExternalBoot(boot, path.join(root, 'boot.json')),
      ).rejects.toThrow('admission failed');
    },
  );

  it('fails closed for missing, public, symlinked and incomplete descriptors', async () => {
    await expect(
      readManagedExternalBoot(boot, path.join(root, 'boot.json')),
    ).rejects.toThrow('admission failed');
    await descriptor();
    await fs.chmod(path.join(root, 'registration.json'), 0o644);
    await expect(
      readManagedExternalBoot(boot, path.join(root, 'boot.json')),
    ).rejects.toThrow('admission failed');
    await fs.chmod(path.join(root, 'registration.json'), 0o600);
    await fs.writeFile(
      path.join(root, 'registration.json'),
      JSON.stringify({
        providerId: 'external-a',
        physicalKey: 'physical-a',
        aliasPath: boot.storage.aliasPath,
        mountRoot: boot.mountRoot,
      }),
    );
    await expect(
      readManagedExternalBoot(boot, path.join(root, 'boot.json')),
    ).rejects.toThrow('admission failed');
    await fs.rename(
      path.join(root, 'registration.json'),
      path.join(root, 'other.json'),
    );
    await fs.symlink(
      path.join(root, 'other.json'),
      path.join(root, 'registration.json'),
    );
    await expect(
      readManagedExternalBoot(boot, path.join(root, 'boot.json')),
    ).rejects.toThrow('admission failed');
  });

  it('rejects writable-by-others and symlinked mount roots', async () => {
    const parsed = await admitted();
    await fs.mkdir(boot.mountRoot, { mode: 0o755 });
    await expect(activateManagedExternalStorage(parsed)).rejects.toThrow(
      'admission failed',
    );
    await fs.rename(boot.mountRoot, path.join(root, 'elsewhere'));
    await fs.symlink(path.join(root, 'elsewhere'), boot.mountRoot);
    await expect(activateManagedExternalStorage(parsed)).rejects.toThrow(
      'admission failed',
    );
  });

  it.each(['legacy', 'files', 'tools'] as const)(
    'exposes distinct publication HTTP routes with lease and revision checks for %s',
    async (profile) => {
      if (profile !== 'legacy')
        boot = {
          ...boot,
          externalFiles: 'external-files/1',
          ...(profile === 'tools' ? { externalShell: true } : {}),
        };
      const original = Server.prototype.listen;
      vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
        this: Server,
        ...args: unknown[]
      ) {
        const callback = args.find((arg) => typeof arg === 'function') as
          | (() => void)
          | undefined;
        return Reflect.apply(original, this, [0, '127.0.0.1', callback]);
      } as typeof Server.prototype.listen);
      const parsed = await admitted();
      const worker = await startManagedRuntimeAttestationWorker(
        parsed,
        undefined,
        undefined,
        true,
      );
      closers.push(worker.close);
      expect(worker.ready.publication?.url).toBeDefined();
      expect(worker.ready.publication?.url).not.toBe(worker.ready.url);
      const endpoint = `${worker.ready.publication!.url}/internal/managed-runtime/v2/publication:begin`;
      const headers = {
        ...(profile === 'legacy'
          ? {}
          : Object.fromEntries(
              Array.from({ length: 32 }, (_, index) => [
                `x-proxy-${index}`,
                'forwarded',
              ]),
            )),
        authorization: `Bearer ${boot.token}`,
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'X-Qwen-Managed-Lease-Id': boot.leaseId,
        'X-Qwen-Managed-Lease-Epoch': '1',
        'X-Qwen-Managed-Storage-Revision': '1',
        'X-Qwen-Managed-Runtime-Incarnation': boot.runtimeIncarnation,
      };
      const body = JSON.stringify({
        protocolVersion: 2,
        ...request,
        expiresAt: Date.now() + 60_000,
      });
      for (const origin of [worker.ready.url, worker.ready.publication!.url]) {
        for (const extra of [
          Object.fromEntries(
            Array.from({ length: 64 }, (_, index) => [
              `x-overflow-${index}`,
              'forwarded',
            ]),
          ),
          { 'x-oversized': 'a'.repeat(17 * 1024) },
          ...(profile === 'legacy'
            ? [
                Object.fromEntries(
                  Array.from({ length: 32 }, (_, index) => [
                    `x-proxy-${index}`,
                    'forwarded',
                  ]),
                ),
              ]
            : []),
        ]) {
          const response = await fetch(
            origin + '/internal/managed-runtime/v3/attest',
            {
              method: 'POST',
              headers: { ...headers, ...extra },
              body: '{}',
            },
          );
          expect(response.status).toBe(431);
          await response.arrayBuffer();
        }
      }
      const attest = await fetch(
        `${worker.ready.url}/internal/managed-runtime/v3/attest`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            protocolVersion: 3,
            managedContext: 'managed-context/1',
            provisionRequestId: boot.provisionRequestId,
            tenantId: boot.tenantId,
            workspaceId: boot.workspaceId,
            workspaceGeneration: boot.workspaceGeneration,
            storageId: boot.storageId,
            mountRoot: boot.mountRoot,
            capabilityDigest: boot.capabilityDigest,
            isolationClass: boot.isolationClass,
          }),
        },
      );
      expect(attest.status).toBe(200);
      expect(await attest.json()).toMatchObject({
        runtimeIncarnation: boot.runtimeIncarnation,
      });
      for (const [header, value, status] of [
        ['authorization', 'Bearer incorrect', 401],
        ['X-Qwen-Managed-Lease-Id', 'unknown', 409],
        ['X-Qwen-Managed-Storage-Revision', '2', 409],
        ['X-Qwen-Managed-Runtime-Incarnation', 'stale', 409],
      ] as const) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, [header]: value },
          body,
        });
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toContain(root);
      }
      if (profile === 'tools') {
        const install = await fetch(
          `${worker.ready.url}/internal/managed-runtime/v3/publications:install`,
          {
            method: 'POST',
            headers,
            body: '{}',
          },
        );
        expect(install.status).toBe(409);
        expect(await install.json()).toMatchObject({
          code: 'managed_tool_publication_conflict',
        });
      }
      const response = await fetch(endpoint, { method: 'POST', headers, body });
      expect(response.status).toBe(200);
      const created = (await response.json()) as {
        protocolVersion: number;
        channelId: string;
      };
      expect(created).toMatchObject({
        protocolVersion: 2,
        channelId: expect.any(String),
      });
      const read = await fetch(
        `${worker.ready.publication!.url}/internal/managed-runtime/v2/publication:read`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            protocolVersion: 2,
            channelId: created.channelId,
            streamId: 'stdout',
            sequence: 0,
            acknowledgedSequence: -1,
          }),
        },
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ state: 'pending' });
      const stop = await fetch(
        `${worker.ready.publication!.url}/internal/managed-runtime/v2/publication:${profile === 'legacy' ? 'stop-drained' : profile + '-stop-drained'}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ protocolVersion: 2, channel: 'all' }),
        },
      );
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({ state: 'undrained' });
      const unavailable = await fetch(
        `${worker.ready.url}/internal/managed-runtime/v2/publication:begin`,
        { method: 'POST', headers, body },
      );
      expect(unavailable.status).toBe(404);
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'external publication capture',
  () => {
    beforeEach(async () => {
      publication = new ManagedExternalPublication(root, boot);
    });

    it('requires a live preinstalled channel and fixes the captured input on retry', async () => {
      await expect(publication!.prepare(request)).rejects.toThrow(
        'publication is closed',
      );
      const expiresAt = Date.now() + 60_000;
      const id = await publication!.begin(request, expiresAt);
      expect(await publication!.begin(request, expiresAt)).toBe(id);
      await expect(
        publication!.begin(
          {
            ...request,
            reference: { ...request.reference, argsDigest: 'b'.repeat(64) },
          },
          expiresAt,
        ),
      ).rejects.toThrow('publication is closed');
      await expect(
        publication!.read('unknown', 'stdout', 0, -1),
      ).rejects.toThrow('publication is closed');
      vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
      await expect(publication!.prepare(request)).rejects.toThrow(
        'publication is closed',
      );
      await expect(publication!.read(id, 'stdout', 0, -1)).rejects.toThrow(
        'publication is closed',
      );
    });

    it('captures real binary stdout/stderr with bounded replay and refuses drain until acknowledged EOF', async () => {
      const channelId = await publication!.begin(request, Date.now() + 60_000);
      const { sink, identity } = await publication!.prepare(request);
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: process.execPath,
          args: [
            '-e',
            'process.stdout.write(Buffer.alloc(70000, 255)); process.stderr.write(Buffer.from([0,192,255]));',
          ],
          cwd: root,
          env: {},
        },
        () => {},
        new AbortController().signal,
        false,
        { maxBufferedOutputBytes: 1024 },
        { rawCapture: sink },
      );
      sink.setStarted(handle.pid!);
      sink.setProcessResult(await handle.result);
      const envelope = await sink.finalize('success', []);
      expect(envelope.capture?.captureStatus).toBe('complete');
      await publication!.finish(identity, envelope);
      const executor = new ManagedToolExecutor(async () => undefined);
      closers.push(() => executor.close());
      expect(await publication!.stopDrained(executor)).toEqual({
        state: 'undrained',
        channels: [channelId],
      });
      for (const [streamId, expected] of [
        ['stdout', Buffer.alloc(70000, 255)],
        ['stderr', Buffer.from([0, 192, 255])],
      ] as const) {
        const chunks: Buffer[] = [];
        let sequence = 0;
        for (;;) {
          const response = await publication!.read(
            channelId,
            streamId,
            sequence,
            sequence - 1,
          );
          expect(response.state).toBe('ready');
          if (response.state !== 'ready')
            throw new Error('capture not settled');
          expect(response.receipt.byteLength).toBeLessThanOrEqual(32 * 1024);
          expect(
            await publication!.read(
              channelId,
              streamId,
              sequence,
              sequence - 1,
            ),
          ).toEqual(response);
          chunks.push(Buffer.from(response.bytes, 'base64'));
          if (response.receipt.eof) {
            await publication!.read(channelId, streamId, sequence, sequence);
            break;
          }
          sequence++;
        }
        expect(Buffer.concat(chunks)).toEqual(expected);
      }
      // Empty buffers alone cannot prove physical drain without the executor ledger.
      expect(await publication!.stopDrained(executor)).toEqual({
        state: 'unknown',
      });
      await expect(
        publication!.begin(
          {
            ...request,
            capture: { ...request.capture, executionCallId: 'later' },
          },
          Date.now() + 60_000,
        ),
      ).rejects.toThrow('publication is closed');
    });
  },
);

it.skipIf(process.platform === 'win32')(
  'persists replayable drain proof after real executor capture and acknowledgements',
  async () => {
    publication = new ManagedExternalPublication(root, boot);
    const ledger = ManagedRuntimeLedger.create({
      workFile: path.join(root, 'ledger.json'),
      worker: {
        pid: process.pid,
        pgid: process.pid,
        hostPid: process.ppid,
        incarnation: boot.runtimeIncarnation,
        startedAt: Date.now(),
      },
    });
    const executor = new ManagedToolExecutor(
      async () => createManagedToolSet(root, 'runtime-session-a'),
      publication,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { ledger, sshForegroundOnly: true },
    );
    closers.push(() => executor.close());
    const input = { command: 'printf publication-witness' };
    const reference = {
      ...request.reference,
      argsDigest: managedToolDigest(input),
    };
    const channelId = await publication.begin(
      { ...request, reference },
      Date.now() + 60_000,
    );
    await executor.executeV3({
      reference,
      input,
      toolName: 'run_shell_command',
      capture: request.capture,
    });
    await vi.waitFor(
      () => expect(executor.statusV3(reference).state).toBe('settled'),
      { timeout: 10_000 },
    );
    const result = executor.statusV3(reference).result!;
    expect(result.capture?.captureStatus).toBe('complete');
    for (const streamId of ['stdout', 'stderr'] as const) {
      let sequence = 0;
      for (;;) {
        const read = await publication.read(
          channelId,
          streamId,
          sequence,
          sequence - 1,
        );
        if (read.state !== 'ready') throw new Error('capture not ready');
        if (streamId === 'stdout' && sequence === 0)
          expect(Buffer.from(read.bytes, 'base64').toString()).toBe(
            'publication-witness',
          );
        if (read.receipt.eof) {
          await publication.read(channelId, streamId, sequence, sequence);
          break;
        }
        sequence++;
      }
    }
    expect(await publication.stopDrained(executor)).toEqual({
      state: 'unknown',
    });
    executor.acknowledgeV3(reference, {
      executionCallId: request.capture.executionCallId,
      manifest: result.capture!.manifest,
      deliveryStatus: 'committed',
      historyRevision: 1,
    });
    const drained = await publication.stopDrained(executor);
    expect(drained).toMatchObject({
      state: 'drained',
      proof: { digest: expect.any(String), byteLength: expect.any(Number) },
    });
    expect(await publication.stopDrained(executor)).toEqual(drained);
    expect((await publication.read(channelId, 'stdout', 0, 1)).state).toBe(
      'ready',
    );
    await expect(
      publication.prepare({ ...request, reference }),
    ).rejects.toThrow('publication is closed');
  },
);
