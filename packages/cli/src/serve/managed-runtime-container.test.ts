/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readManagedRuntimeContainerBoot,
  readManagedRuntimeWorkerBoot,
  runManagedRuntimeAttestationWorker,
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeWorkerBoot,
} from './managed-runtime-attestation-worker.js';
import {
  parseManagedCsiBoot,
  createManagedCsiDrainRequest,
  MANAGED_CSI_DRAIN_PATH,
  type ManagedCsiPodIdentity,
  type ManagedCsiMountReceipt,
} from './managed-csi-envelope.js';
import { ManagedCsiMount } from './managed-csi-mount.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
  WORKSPACE_EXECUTION_PROFILE,
  WORKSPACE_ACTIVATION_ROUTE,
} from './managed-workspace-activation.js';
import {
  RemoteShellResultPublisher,
  PUBLICATION_INSTALL_ROUTE,
} from './remote-shell-result-publication.js';
import {
  ManagedShellPublisherRegistry,
  MANAGED_SHELL_PUBLISHER_ROUTE,
} from './managed-shell-publisher.js';

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
  it('wires the gate in the actual boot3 startup while preserving boot2 route ownership', async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL('./contracts/managed-csi-v1.fixtures.json', import.meta.url),
        'utf8',
      ),
    ) as {
      boot: unknown;
      expectedPod: ManagedCsiPodIdentity;
      attestationResponse: { mount: ManagedCsiMountReceipt };
    };
    const fixture = parseManagedCsiBoot(fixtures.boot);
    const boot = parseManagedCsiBoot({
      ...fixture,
      context: {
        ...fixture.context,
        capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
      },
    });
    vi.stubEnv('QWEN_POD_UID', fixtures.expectedPod.uid);
    vi.stubEnv('QWEN_POD_NAMESPACE', fixtures.expectedPod.namespace);
    vi.stubEnv('QWEN_NODE_NAME', fixtures.expectedPod.nodeName);
    const retirementId = '12345678-1234-5678-9abc-000000000001';
    const body = () =>
      createManagedCsiDrainRequest(
        boot,
        fixtures.expectedPod,
        retirementId,
        'seal',
      );
    const headers = {
      Authorization: `Bearer ${boot.context.token}`,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Qwen-Managed-Lease-Id': boot.context.leaseId,
      'X-Qwen-Managed-Lease-Epoch': String(boot.context.epoch),
    };
    const post = (origin: string, value: unknown) =>
      fetch(origin + MANAGED_CSI_DRAIN_PATH, {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      });
    vi.spyOn(ManagedCsiMount.prototype, 'observe').mockResolvedValue(
      fixtures.attestationResponse.mount,
    );
    vi.spyOn(ManagedCsiMount.prototype, 'isAvailable', 'get').mockReturnValue(
      true,
    );
    vi.spyOn(ManagedCsiMount.prototype, 'resolve').mockResolvedValue(
      boot.context.mountRoot,
    );
    const publicationInstall = vi.spyOn(
      RemoteShellResultPublisher.prototype,
      'install',
    );
    const localPublications = new ManagedShellPublisherRegistry();
    const worker = await startManagedRuntimeAttestationWorker(
      boot,
      undefined,
      localPublications,
      true,
    );
    try {
      const binding = {
        tenantId: boot.context.tenantId,
        workspaceId: boot.context.workspaceId,
        workspaceGeneration: boot.context.workspaceGeneration,
        storageId: boot.context.storageId,
        cwdRelative: '.',
        contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
        contextRevision: '1',
      };
      const contextDigest = computeManagedContextDigest(binding);
      const installation = {
        protocolVersion: 3,
        managedContext: 'managed-context/1',
        operationId: 'install-original',
        sessionId: 'session-original',
        binding,
        contextDigest,
      };
      const send = (route: string, value: unknown) =>
        fetch(worker.ready.url + route, {
          method: 'POST',
          headers,
          body: JSON.stringify(value),
        });
      const installPath = '/internal/managed-runtime/v3/context';
      const original = await send(installPath, installation);
      expect(original.status).toBe(200);
      const receipt: unknown = await original.json();
      const activation = {
        protocolVersion: 1,
        profile: WORKSPACE_EXECUTION_PROFILE,
        sessionId: installation.sessionId,
        contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
        contextDigest,
        operation: 'activate',
      };
      expect(
        (await send(WORKSPACE_ACTIVATION_ROUTE.path, activation)).status,
      ).toBe(200);
      const publisherInstallation = {
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        sessionId: installation.sessionId,
        publisher: {
          url: 'http://127.0.0.1:4567/internal/hosted-shell-publisher/v1',
          token: 'A'.repeat(43),
        },
      };
      expect(localPublications.hasInstalledPublication).toBe(false);
      expect(
        (await send(MANAGED_SHELL_PUBLISHER_ROUTE.path, publisherInstallation))
          .status,
      ).toBe(200);
      expect(localPublications.hasInstalledPublication).toBe(true);
      const sealed = await post(worker.ready.url, body());
      expect(sealed.status).toBe(200);
      expect(await sealed.json()).toMatchObject({
        workState: 'BLOCKED',
        pendingStarts: 0,
        pendingInvocations: 0,
        blockers: ['publication_lifecycle_unqualified'],
      });
      expect(
        (await send(MANAGED_SHELL_PUBLISHER_ROUTE.path, publisherInstallation))
          .status,
      ).toBe(409);
      const replay = await send(installPath, installation);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(receipt);
      const install = await send(installPath, {
        ...installation,
        operationId: 'install-new',
        sessionId: 'session-new',
      });
      expect(
        (await send(WORKSPACE_ACTIVATION_ROUTE.path, activation)).status,
      ).toBe(409);
      expect(
        (
          await send(WORKSPACE_ACTIVATION_ROUTE.path, {
            ...activation,
            operation: 'release',
          })
        ).status,
      ).toBe(200);
      expect((await send(PUBLICATION_INSTALL_ROUTE.path, {})).status).toBe(409);
      expect(publicationInstall).not.toHaveBeenCalled();
      expect(install.status).toBe(409);
      expect(await install.json()).toMatchObject({
        code: 'managed_context_unavailable',
      });
    } finally {
      await worker.close();
    }
    const local = await startManagedRuntimeAttestationWorker(boot.context);
    try {
      expect((await post(local.ready.url, body())).status).toBe(404);
    } finally {
      await local.close();
    }
  });

  it('decodes boot v3 only through the container file, and keeps its Linux mount gate', async () => {
    const fixtures = JSON.parse(
      await readFile(
        new URL('./contracts/managed-csi-v1.fixtures.json', import.meta.url),
        'utf8',
      ),
    ) as { boot: unknown };
    const csi = parseManagedCsiBoot(fixtures.boot);
    const filename = await bootFile(JSON.stringify(csi));
    expect(await readManagedRuntimeContainerBoot(filename)).toEqual(csi);
    await expect(
      readManagedRuntimeWorkerBoot(Readable.from([JSON.stringify(csi)])),
    ).rejects.toThrow();
    await expect(startManagedRuntimeAttestationWorker(csi)).rejects.toThrow(
      'Managed Runtime worker boot payload is invalid.',
    );
    if (process.platform !== 'linux') {
      await expect(
        startManagedRuntimeAttestationWorker(csi, undefined, undefined, true),
      ).rejects.toThrow('Managed CSI mount is unavailable.');
    }
  });
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
