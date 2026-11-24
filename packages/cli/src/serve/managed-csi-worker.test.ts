/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedCsiMount } from './managed-csi-mount.js';
import {
  MANAGED_CSI_ATTEST_PATH,
  MANAGED_CSI_DRAIN_PATH,
  MANAGED_CSI_ACK_PATH,
  type ManagedCsiAckRequest,
  type ManagedCsiAckResponse,
  createManagedCsiDrainRequest,
  parseManagedCsiBoot,
  type ManagedCsiMountReceipt,
  type ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';
import {
  MANAGED_CSI_ATTEST_ROUTE,
  MANAGED_CSI_DRAIN_ROUTE,
  MANAGED_CSI_ACK_ROUTE,
  registerManagedCsiAttestationRoute,
  registerManagedCsiDrainRoute,
  registerManagedCsiAckRoute,
} from './managed-csi-worker.js';
import { ownedManagedRuntimeRouteGate } from './managed-runtime-attestation-contract.js';
import {
  ManagedToolExecutor,
  type ManagedShellCaptureSink,
} from './managed-runtime-tool-executor.js';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-v1.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  boot: unknown;
  attestationRequest: Record<string, unknown>;
  expectedPod: ManagedCsiPodIdentity;
  attestationResponse: { mount: ManagedCsiMountReceipt };
};
const boot = parseManagedCsiBoot(fixtures.boot);
const servers: Server[] = [];

beforeEach(() => {
  vi.stubEnv('QWEN_POD_UID', fixtures.expectedPod.uid);
  vi.stubEnv('QWEN_POD_NAMESPACE', fixtures.expectedPod.namespace);
  vi.stubEnv('QWEN_NODE_NAME', fixtures.expectedPod.nodeName);
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function endpoint(
  executor = new ManagedToolExecutor(async () => undefined),
) {
  const app = express();
  const mount = new ManagedCsiMount(
    boot.context.mountRoot,
    boot.storage.diskSerial,
  );
  const observer = vi
    .spyOn(mount, 'observe')
    .mockResolvedValue(fixtures.attestationResponse.mount);
  const availability = vi
    .spyOn(mount, 'isAvailable', 'get')
    .mockReturnValue(true);
  registerManagedCsiAttestationRoute(app, boot, mount);
  registerManagedCsiDrainRoute(app, boot, executor);
  registerManagedCsiAckRoute(app, boot, executor);
  const server = createServer(
    ownedManagedRuntimeRouteGate(app, [
      MANAGED_CSI_ATTEST_ROUTE,
      MANAGED_CSI_DRAIN_ROUTE,
      MANAGED_CSI_ACK_ROUTE,
    ]),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observer,
    availability,
    executor,
  };
}

const headers = {
  Authorization: `Bearer ${boot.context.token}`,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
  'X-Qwen-Managed-Lease-Id': boot.context.leaseId,
  'X-Qwen-Managed-Lease-Epoch': String(boot.context.epoch),
};

describe('private CSI attestation HTTP boundary', () => {
  it('returns the closed receipt only after an authenticated original reservation observation', async () => {
    const { origin, observer } = await endpoint();
    const response = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(fixtures.attestationRequest),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(fixtures.attestationResponse);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it.each([
    { Authorization: 'Bearer other', status: 401 },
    { 'X-Qwen-Managed-Lease-Id': 'other', status: 409 },
    { 'X-Qwen-Managed-Lease-Epoch': '01', status: 409 },
    { 'Cache-Control': 'max-age=1', status: 400 },
  ])(
    'refuses incorrect credentials or headers before observing the mount',
    async ({ status, ...override }) => {
      const { origin, observer } = await endpoint();
      const response = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
        method: 'POST',
        headers: { ...headers, ...override },
        body: JSON.stringify(fixtures.attestationRequest),
      });
      expect(response.status).toBe(status);
      expect(observer).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      body: JSON.stringify({
        ...fixtures.attestationRequest,
        reservationId: 'other',
      }),
      status: 409,
    },
    {
      body: JSON.stringify({ ...fixtures.attestationRequest, extra: true }),
      status: 409,
    },
    { body: '{invalid', status: 400 },
    { body: ' '.repeat(17 * 1024), status: 413 },
  ])(
    'refuses malformed or crossed reservations before observing',
    async ({ body, status }) => {
      const { origin, observer } = await endpoint();
      const response = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
        method: 'POST',
        headers,
        body,
      });
      expect(response.status).toBe(status);
      expect(observer).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(boot.context.token);
    },
  );

  it('redacts observer failures and rejects inconsistent device receipts', async () => {
    const { origin, observer } = await endpoint();
    observer
      .mockRejectedValueOnce(new Error('private volume and path detail'))
      .mockResolvedValueOnce({
        ...fixtures.attestationResponse.mount,
        rootDevice: '1',
      });
    for (let index = 0; index < 2; index++) {
      const response = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
        method: 'POST',
        headers,
        body: JSON.stringify(fixtures.attestationRequest),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'managed_csi_mount_unavailable',
        error: 'Managed CSI mount is unavailable.',
      });
    }
  });

  it('refuses a receipt after another observation permanently fenced the mount', async () => {
    const { origin, observer, availability } = await endpoint();
    observer.mockImplementationOnce(async () => {
      availability.mockReturnValue(false);
      return fixtures.attestationResponse.mount;
    });
    const response = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(fixtures.attestationRequest),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'managed_csi_mount_unavailable',
      error: 'Managed CSI mount is unavailable.',
    });
  });

  it('keeps unowned paths and methods closed', async () => {
    const { origin, observer } = await endpoint();
    for (const [method, path] of [
      ['GET', MANAGED_CSI_ATTEST_PATH],
      ['POST', `${MANAGED_CSI_ATTEST_PATH}/`],
    ]) {
      const response = await fetch(origin + path, { method, headers });
      expect(response.status).toBe(404);
    }
    expect(observer).not.toHaveBeenCalled();
  });

  it.each(['QWEN_POD_UID', 'QWEN_POD_NAMESPACE', 'QWEN_NODE_NAME'])(
    'refuses absent or invalid downward identity %s before listening',
    (name) => {
      vi.stubEnv(name, '');
      expect(() =>
        registerManagedCsiAttestationRoute(
          express(),
          boot,
          new ManagedCsiMount('/workspace', boot.storage.diskSerial),
        ),
      ).toThrow();
    },
  );
});

describe('private CSI admission seal HTTP boundary', () => {
  const retirementId = '12345678-1234-5678-9abc-000000000001';
  const body = (operation: 'seal' | 'status' = 'seal') =>
    createManagedCsiDrainRequest(
      boot,
      fixtures.expectedPod,
      retirementId,
      operation,
    );
  const post = (origin: string, value: unknown, override = {}) =>
    fetch(origin + MANAGED_CSI_DRAIN_PATH, {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(value),
    });

  it('seals exactly one operation while keeping the original identity and listener available', async () => {
    const { origin, executor, observer } = await endpoint();
    expect((await post(origin, body('status'))).status).toBe(409);
    expect(executor.isAdmissionOpen).toBe(true);
    const first = await post(origin, body());
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const observation = await first.json();
    expect(observation).toMatchObject({
      retirementId,
      state: 'DRAINING',
      workState: 'QUIESCENT',
      pendingStarts: 0,
      pendingInvocations: 0,
      blockers: [],
      storage: boot.storage,
      pod: fixtures.expectedPod,
    });
    expect(JSON.stringify(observation)).not.toContain(boot.context.token);
    expect(JSON.stringify(observation)).not.toContain('DRAINED');
    expect(executor.isAdmissionOpen).toBe(false);
    expect(await (await post(origin, body())).json()).toEqual(observation);
    expect(await (await post(origin, body('status'))).json()).toEqual(
      observation,
    );
    expect(
      (
        await post(origin, {
          ...body(),
          retirementId: '12345678-1234-5678-9abc-000000000002',
        })
      ).status,
    ).toBe(409);
    expect(executor.isAdmissionOpen).toBe(false);
    expect(observer).not.toHaveBeenCalled();
    const attest = await fetch(origin + MANAGED_CSI_ATTEST_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(fixtures.attestationRequest),
    });
    expect(attest.status).toBe(200);
  });

  it.each([
    { override: { Authorization: 'Bearer other' }, status: 401 },
    { override: { 'X-Qwen-Managed-Lease-Id': 'other' }, status: 409 },
    { override: { 'X-Qwen-Managed-Lease-Epoch': '04' }, status: 409 },
    { override: { 'Cache-Control': 'max-age=1' }, status: 400 },
  ])('authenticates before sealing', async ({ override, status }) => {
    const { origin, executor } = await endpoint();
    expect((await post(origin, body(), override)).status).toBe(status);
    expect(executor.isAdmissionOpen).toBe(true);
  });

  it.each([
    { change: { extra: true }, status: 400 },
    { change: { retirementId: 'not-a-uuid' }, status: 400 },
    { change: { operation: 'close' }, status: 400 },
    { change: { protocolVersion: 2 }, status: 409 },
    {
      change: {
        context: { ...body().context, runtimeIncarnation: 'replacement' },
      },
      status: 409,
    },
    { change: { context: { ...body().context, epoch: 5 } }, status: 409 },
    {
      change: { storage: { ...boot.storage, reservationRevision: '2' } },
      status: 409,
    },
    {
      change: {
        pod: {
          ...fixtures.expectedPod,
          uid: '12345678-1234-5678-9abc-000000000003',
        },
      },
      status: 409,
    },
  ])(
    'refuses crossed or malformed original pins before sealing',
    async ({ change, status }) => {
      const { origin, executor } = await endpoint();
      const response = await post(origin, { ...body(), ...change });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(boot.context.token);
      expect(executor.isAdmissionOpen).toBe(true);
    },
  );

  it.each([
    { raw: '{invalid', status: 400 },
    { raw: JSON.stringify(body()) + '{}', status: 400 },
    { raw: ' '.repeat(17 * 1024), status: 413 },
  ])('rejects invalid wire bodies without sealing', async ({ raw, status }) => {
    const { origin, executor } = await endpoint();
    const response = await fetch(origin + MANAGED_CSI_DRAIN_PATH, {
      method: 'POST',
      headers,
      body: raw,
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(boot.context.token);
    expect(executor.isAdmissionOpen).toBe(true);
  });

  it('keeps unowned drain methods and path variants closed', async () => {
    const { origin, executor } = await endpoint();
    for (const [method, path] of [
      ['GET', MANAGED_CSI_DRAIN_PATH],
      ['POST', `${MANAGED_CSI_DRAIN_PATH}/`],
    ]) {
      const response = await fetch(origin + path, { method, headers });
      expect(response.status).toBe(404);
    }
    expect(executor.isAdmissionOpen).toBe(true);
  });
});

const ackFixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-worker-ack-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  request: ManagedCsiAckRequest;
  response: ManagedCsiAckResponse;
  input: Record<string, unknown>;
  capture: LocalShellCaptureRequest['capture'];
};

async function ackEndpoint() {
  const identity = { ...ackFixture.response.captureIdentity };
  const prepare = vi.fn(async () => ({
    identity,
    sink: {
      identity,
      finalize: async () => ({
        executionStatus: 'success',
        responseParts: [],
        capture: {
          captureStatus: 'complete',
          captureReason: null,
          deliveryStatus: 'pending',
          previewTruncated: false,
          manifest: ackFixture.request.acknowledgement.manifest,
        },
      }),
    } as unknown as ManagedShellCaptureSink,
  }));
  const execute = vi.fn(async () => ({
    llmContent: 'original result',
    returnDisplay: 'original result',
  }));
  const executor = new ManagedToolExecutor(
    async () => ({
      sessionId: ackFixture.request.reference.sessionId,
      admitsDirectory: () => true,
      tools: new Map([
        [
          'run_shell_command',
          {
            validateToolParams: () => null,
            build: () => ({ execute }),
          } as unknown as AnyDeclarativeTool,
        ],
      ]),
    }),
    { prepare },
  );
  await executor.executeV3({
    reference: ackFixture.request.reference,
    capture: ackFixture.capture,
    toolName: 'run_shell_command',
    input: ackFixture.input,
  });
  executor.sealAdmission(ackFixture.request.retirementId);
  return { ...(await endpoint(executor)), prepare, execute };
}

describe('owned original CSI worker ACK HTTP boundary', () => {
  const post = (
    origin: string,
    body: unknown = ackFixture.request,
    override = {},
  ) =>
    fetch(origin + MANAGED_CSI_ACK_PATH, {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(body),
    });
  it('sends the exact synchronously checked original tuple and preserves generic status/ACK replay', async () => {
    const { origin, executor, prepare, execute, observer } =
      await ackEndpoint();
    const confirmer = vi.spyOn(executor, 'acknowledgeOriginalCsi');
    const response = await post(origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    const raw = await response.text();
    expect(raw).toBe(confirmer.mock.results[0].value.json);
    expect(JSON.parse(raw)).toEqual(ackFixture.response);
    expect(raw).not.toContain(boot.context.token);
    expect(await (await post(origin)).json()).toEqual(ackFixture.response);
    expect(
      executor.statusV3(ackFixture.request.reference).result?.capture
        ?.deliveryStatus,
    ).toBe('committed');
    expect(
      executor.getDrainObservation(ackFixture.request.retirementId).workState,
    ).toBe('BLOCKED');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();
  });
  it.each([
    [{ Authorization: 'Bearer wrong' }, 401],
    [{ 'X-Qwen-Managed-Lease-Id': 'wrong' }, 409],
    [{ 'X-Qwen-Managed-Lease-Epoch': '04' }, 409],
    [{ 'Cache-Control': 'max-age=1' }, 400],
  ])(
    'authenticates the original lease before confirming',
    async (override, status) => {
      const { origin, executor } = await ackEndpoint();
      const setter = vi.spyOn(executor, 'acknowledgeV3');
      expect((await post(origin, ackFixture.request, override)).status).toBe(
        status,
      );
      expect(setter).not.toHaveBeenCalled();
      expect(
        executor.statusV3(ackFixture.request.reference).result?.capture
          ?.deliveryStatus,
      ).toBe('pending');
    },
  );
  it.each([
    [{ extra: true }, 400],
    [{ retirementId: 'bad' }, 400],
    [{ retirementId: '550e8400-e29b-41d4-a716-446655440001' }, 409],
    [
      {
        context: {
          ...ackFixture.request.context,
          runtimeIncarnation: 'replacement',
        },
      },
      409,
    ],
    [
      { storage: { ...ackFixture.request.storage, reservationRevision: '2' } },
      409,
    ],
    [
      { reference: { ...ackFixture.request.reference, callId: 'missing' } },
      409,
    ],
    [
      {
        acknowledgement: {
          ...ackFixture.request.acknowledgement,
          deliveryStatus: 'blocked',
        },
      },
      400,
    ],
  ])(
    'refuses malformed and crossed original tuples before setter',
    async (change, status) => {
      const { origin, executor } = await ackEndpoint();
      const setter = vi.spyOn(executor, 'acknowledgeV3');
      const response = await post(origin, { ...ackFixture.request, ...change });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(boot.context.token);
      expect(setter).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['{bad', 400],
    [JSON.stringify(ackFixture.request) + '{}', 400],
    [' '.repeat(17 * 1024), 413],
  ])(
    'rejects bounded malformed JSON before confirmation',
    async (raw, status) => {
      const { origin, executor } = await ackEndpoint();
      const setter = vi.spyOn(executor, 'acknowledgeV3');
      const response = await fetch(origin + MANAGED_CSI_ACK_PATH, {
        method: 'POST',
        headers,
        body: raw,
      });
      expect(response.status).toBe(status);
      expect(setter).not.toHaveBeenCalled();
    },
  );
  it('does not confirm a restarted missing entry and keeps method/path variants unowned', async () => {
    const { origin, executor } = await endpoint();
    executor.sealAdmission(ackFixture.request.retirementId);
    expect((await post(origin)).status).toBe(409);
    for (const [method, path] of [
      ['GET', MANAGED_CSI_ACK_PATH],
      ['POST', MANAGED_CSI_ACK_PATH + '/'],
      ['POST', MANAGED_CSI_ACK_PATH + '?extra=1'],
    ]) {
      expect((await fetch(origin + path, { method, headers })).status).toBe(
        404,
      );
    }
  });
});

describe('CSI-only exact original ACK wire numbers', () => {
  it.each([
    ['historyRevision', '7.0000000000000001'],
    ['epoch', '4.0000000000000001'],
    ['schemaVersion', '1.0000000000000001'],
    ['byteLength', '1024.0000000000000001'],
    ['protocolVersion', '1.0000000000000001'],
    ['historyRevision', '7.0'],
    ['historyRevision', '7e0'],
  ])(
    'rejects the raw noncanonical number %s=%s before mutation',
    async (field, literal) => {
      const { origin, executor } = await ackEndpoint();
      const setter = vi.spyOn(executor, 'acknowledgeV3');
      const raw = JSON.stringify(ackFixture.request).replace(
        new RegExp('"' + field + '":[0-9]+'),
        '"' + field + '":' + literal,
      );
      const response = await fetch(origin + MANAGED_CSI_ACK_PATH, {
        method: 'POST',
        headers,
        body: raw,
      });
      expect(response.status).toBe(400);
      expect(setter).not.toHaveBeenCalled();
      expect(
        executor.statusV3(ackFixture.request.reference).result?.capture
          ?.deliveryStatus,
      ).toBe('pending');
    },
  );
  it('rejects duplicate JSON fields rather than collapsing them into one ACK', async () => {
    const { origin, executor } = await ackEndpoint();
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    const raw = JSON.stringify(ackFixture.request).replace(
      '"historyRevision":7',
      '"historyRevision":7,"historyRevision":7',
    );
    const response = await fetch(origin + MANAGED_CSI_ACK_PATH, {
      method: 'POST',
      headers,
      body: raw,
    });
    expect(response.status).toBe(400);
    expect(setter).not.toHaveBeenCalled();
  });
});
