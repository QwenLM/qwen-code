/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest, E2bProvider } from './provider.js';
import type { Boot, Cloud, Registration } from './provider.js';
import { providerServer } from './server.js';

const registration: Registration = {
  providerId: 'e2b-cloud',
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  volumeId: 'vol-a',
  physicalKey: 'vol-a',
  registrationRevision: 1,
  aliasPath: '/external/workspace-a',
  mountRoot: '/workspace',
};
const boot: Boot = {
  type: 'boot',
  version: 2,
  managedContext: 'managed-context/1',
  externalFiles: 'external-files/1',
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  workspaceGeneration: '1',
  storageId: 'workspace-a',
  mountRoot: '/workspace',
  runtimeInstanceId: 'runtime-a',
  runtimeIncarnation: 'incarnation-a',
  provisionRequestId: 'request-a',
  leaseId: 'lease-a',
  epoch: 1,
  token: 'private-worker-fixture-token',
  isolationClass: 'session',
  capabilityDigest:
    'sha256:7df3981fa14b397fe09f6ba84ed0c096c71902394da667bf47f3b315866e7f91',
  storage: {
    kind: 'external',
    physicalKey: 'vol-a',
    registrationRevision: 1,
    aliasPath: '/external/workspace-a',
    mountRoot: '/workspace',
  },
};
function request() {
  const { token: _token, ...identity } = boot;
  return {
    protocolVersion: 1,
    provisionRequestId: boot.provisionRequestId,
    identity: digest({
      version: 1,
      providerId: 'e2b-cloud',
      isolationKey: 'session-a',
      boot: identity,
    }),
    handle: { requestId: boot.provisionRequestId },
    boot,
    scope: {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      workspaceGeneration: '1',
      workspaceCwd: '/workspace',
      isolationClass: 'session',
      isolationKey: 'session-a',
    },
  };
}
const observation = () => {
  const { boot: _boot, scope: _scope, ...input } = request();
  return input;
};

describe('durable E2B provider and protected ingress', () => {
  let directory: string;
  let provider: E2bProvider;
  let cloud: Cloud;
  let server: Server | undefined;
  beforeEach(async () => {
    directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'qwen-e2b-provider-')),
    );
    cloud = {
      credentialIdentity: 'c'.repeat(64),
      create: vi.fn(async () => ({
        sandboxId: 'sandbox-a',
        sandboxDomain: 'e2b.test',
        envdVersion: '0.6.0',
        trafficAccessToken: 'fixture-traffic',
      })),
      find: vi.fn(async () => ['sandbox-a']),
      launch: vi.fn(async () => undefined),
      observe: vi.fn(async () => 'RUNNING' as const),
      stop: vi.fn(async () => true),
      forward: vi.fn(
        async () =>
          new Response('{"fixture":true}', {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            },
          }),
      ),
    };
    provider = await E2bProvider.open(
      directory,
      cloud,
      'e2b-cloud',
      [registration],
      'workers.example.test',
    );
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('creates and launches once across concurrent requests and adapter restart', async () => {
    await Promise.all([
      provider.provision(request()),
      provider.provision(request()),
      provider.provision(request()),
    ]);
    expect(cloud.create).toHaveBeenCalledTimes(1);
    expect(cloud.launch).toHaveBeenCalledTimes(1);
    const before = await provider.observe(observation());
    provider.close();
    provider = await E2bProvider.open(
      directory,
      cloud,
      'e2b-cloud',
      [registration],
      'workers.example.test',
    );
    await provider.provision(request());
    expect(await provider.observe(observation())).toEqual(before);
    expect(cloud.create).toHaveBeenCalledTimes(1);
    expect(cloud.launch).toHaveBeenCalledTimes(1);
    expect(before).toMatchObject({
      state: 'RUNNING',
      storage: {
        continuity: 'confirms',
        storageRef: digest({
          providerId: 'e2b-cloud',
          physicalKey: 'vol-a',
          registrationRevision: 1,
        }),
      },
    });
  });
  it('retains unknown create outcomes without a second sandbox or an observation launch', async () => {
    vi.mocked(cloud.create).mockRejectedValueOnce(new Error('response lost'));
    await expect(provider.provision(request())).rejects.toThrow(
      'response lost',
    );
    await provider.provision(request());
    expect(await provider.observe(observation())).toEqual({
      protocolVersion: 1,
      state: 'UNKNOWN',
    });
    expect(cloud.create).toHaveBeenCalledTimes(1);
    expect(cloud.find).toHaveBeenCalledTimes(1);
    expect(cloud.launch).not.toHaveBeenCalled();
  });
  it('refuses changed boot credentials and foreign storage on the same identity', async () => {
    await provider.provision(request());
    await expect(
      provider.provision({
        ...request(),
        boot: { ...boot, token: 'different-private-fixture-token' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      provider.provision({
        ...request(),
        scope: { ...request().scope, tenantId: 'tenant-b' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(cloud.create).toHaveBeenCalledTimes(1);
  });
  it('refuses another E2B credential reopening the original journal', async () => {
    await provider.provision(request());
    await expect(
      E2bProvider.open(
        directory,
        { ...cloud, credentialIdentity: 'd'.repeat(64) },
        'e2b-cloud',
        [registration],
        'workers.example.test',
      ),
    ).rejects.toThrow('original E2B credential');
    expect(cloud.stop).not.toHaveBeenCalled();
  });
  it('rejects mapping one Volume into two tenant storage identities', async () => {
    await expect(
      E2bProvider.open(
        directory,
        cloud,
        'e2b-cloud',
        [
          registration,
          {
            ...registration,
            tenantId: 'tenant-b',
            workspaceId: 'workspace-b',
            aliasPath: '/external/workspace-b',
          },
        ],
        'workers.example.test',
      ),
    ).rejects.toThrow('Duplicate');
  });
  it('persists the original drain proof before stop and recovers a lost stop response without the worker', async () => {
    await provider.provision(request());
    const command = {
      ...observation(),
      retirementKey: 'a'.repeat(64),
      confirmOnly: true,
    };
    expect(await provider.retire(command)).toEqual({
      protocolVersion: 1,
      state: 'UNKNOWN',
    });
    expect(cloud.stop).not.toHaveBeenCalled();
    const proof = {
      proofVersion: 1,
      type: 'files-stop-drained',
      profile: 'external-files/1',
      tenantId: boot.tenantId,
      workspaceId: boot.workspaceId,
      workspaceGeneration: boot.workspaceGeneration,
      storageId: boot.storageId,
      storage: boot.storage,
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: boot.runtimeIncarnation,
      provisionRequestId: boot.provisionRequestId,
      capabilityDigest: boot.capabilityDigest,
      leaseId: boot.leaseId,
      epoch: boot.epoch,
      retirementId: '550e8400-e29b-41d4-a716-446655440000',
      retiredAt: new Date().toISOString(),
      filesOnly: true,
      unreleasedSessions: 0,
      pendingInvocations: 0,
      channels: [],
    };
    const bytes = Buffer.from(JSON.stringify(proof));
    const envelope = {
      protocolVersion: 2,
      state: 'drained',
      proof: {
        resourceId: '550e8400-e29b-41d4-a716-446655440001',
        kind: 'external-files-retirement',
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
      proofBytes: bytes.toString('base64'),
    };
    await expect(
      provider.retire({
        ...command,
        confirmOnly: false,
        proof: {
          ...envelope,
          proofBytes: Buffer.from('tampered').toString('base64'),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(cloud.stop).not.toHaveBeenCalled();
    vi.mocked(cloud.stop).mockRejectedValueOnce(
      new Error('kill response lost'),
    );
    await expect(
      provider.retire({ ...command, confirmOnly: false, proof: envelope }),
    ).rejects.toThrow('kill response lost');
    provider.close();
    provider = await E2bProvider.open(
      directory,
      cloud,
      'e2b-cloud',
      [registration],
      'workers.example.test',
    );
    vi.mocked(cloud.stop).mockResolvedValueOnce(false);
    expect(await provider.retire(command)).toMatchObject({
      state: 'RETIRING',
      proof: envelope,
      retirementKey: command.retirementKey,
    });
    const stopped = await provider.retire({
      ...command,
      confirmOnly: false,
      proof: envelope,
    });
    expect(stopped).toMatchObject({
      state: 'STOPPED',
      proof: envelope,
      retirementKey: command.retirementKey,
    });
    expect(cloud.stop).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(cloud.stop).toHaveBeenNthCalledWith(2, expect.anything(), true);
    expect(cloud.stop).toHaveBeenNthCalledWith(3, expect.anything(), false);
    expect(await provider.retire(command)).toEqual(stopped);
    expect(cloud.stop).toHaveBeenCalledTimes(3);
  });

  it('checks gateway credentials before forwarding and exposes only declared routes', async () => {
    await provider.provision(request());
    const answer = (await provider.observe(observation())) as {
      endpoint: string;
    };
    const host = new URL(answer.endpoint).hostname;
    server = providerServer(provider, cloud, 'private-provider-fixture-token');
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected listener');
    const send = (route: string, authorization: string, targetHost = host) =>
      new Promise<{ status: number }>((resolve, reject) => {
        const outgoing = httpRequest(
          `http://127.0.0.1:${address.port}${route}`,
          {
            method: 'POST',
            headers: {
              host: targetHost,
              'content-type': 'application/json',
              'cache-control': 'no-store',
              authorization,
              'x-qwen-managed-lease-id': boot.leaseId,
              'x-qwen-managed-lease-epoch': '1',
              'e2b-traffic-access-token': 'attacker-controlled',
            },
          },
          (reply) => {
            reply.resume();
            reply.on('end', () => resolve({ status: reply.statusCode! }));
          },
        );
        outgoing.on('error', reject);
        outgoing.end('{}');
      });
    expect(
      (await send('/internal/managed-runtime/v3/attest', 'Bearer bad')).status,
    ).toBe(401);
    expect(
      (
        await send(
          '/internal/managed-runtime/v3/attest',
          'Bearer ' + boot.token,
          'foreign.example.test',
        )
      ).status,
    ).toBe(401);
    expect(
      (await send('/arbitrary-target', 'Bearer ' + boot.token)).status,
    ).toBe(404);
    expect(cloud.forward).not.toHaveBeenCalled();
    expect(
      (
        await send(
          '/internal/managed-runtime/v3/attest',
          'Bearer ' + boot.token,
        )
      ).status,
    ).toBe(200);
    expect(cloud.forward).toHaveBeenCalledWith(
      expect.anything(),
      43190,
      '/internal/managed-runtime/v3/attest',
      expect.not.objectContaining({
        'e2b-traffic-access-token': expect.anything(),
      }),
      expect.any(Buffer),
    );
    expect(
      (await send('/provider/provision', 'Bearer ' + boot.token)).status,
    ).toBe(401);
    expect(
      (
        await send(
          '/internal/managed-runtime/v2/publication:files-stop-drained',
          'Bearer ' + boot.token,
        )
      ).status,
    ).toBe(200);
    expect(vi.mocked(cloud.forward).mock.calls[1]?.[1]).toBe(43191);
    const retired = await fetch(
      `http://127.0.0.1:${address.port}/provider/retire`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          authorization: 'Bearer private-provider-fixture-token',
        },
        body: JSON.stringify({
          ...observation(),
          retirementKey: 'a'.repeat(64),
          confirmOnly: true,
        }),
      },
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({
      protocolVersion: 1,
      state: 'UNKNOWN',
    });
    expect(cloud.stop).not.toHaveBeenCalled();
  });
});
