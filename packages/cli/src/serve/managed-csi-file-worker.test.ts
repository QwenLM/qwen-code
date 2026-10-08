/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedCsiMount } from './managed-csi-mount.js';
import type { ManagedCsiMountReceipt } from './managed-csi-envelope.js';
import {
  parseManagedCsiFileBoot,
  MANAGED_CSI_FILE_PREFIX,
} from './managed-csi-file-envelope.js';
import {
  readManagedRuntimeContainerBoot,
  readManagedRuntimeWorkerBoot,
  startManagedRuntimeAttestationWorker,
} from './managed-runtime-attestation-worker.js';
import * as contextWorker from './managed-context-worker.js';
import * as composer from './managed-csi-file-composer.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import type { ManagedCsiFileWorkerHandle } from './managed-csi-file-worker.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-files-v2.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  boot: unknown;
  executionBoot5: unknown;
  expectedPod: { uid: string; namespace: string; nodeName: string };
  attestationRequest: unknown;
  attestationResponse: { mount: ManagedCsiMountReceipt };
  contextAttestationRequest: unknown;
  contextAttestationResponse: unknown;
  installationRequest: {
    context: {
      binding: ManagedContextBinding;
      sessionId: string;
      contextDigest: string;
    };
  };
  installationResponse: unknown;
  drainRequest: { operation: string; retirementId: string };
  drainResponse: unknown;
};
const boot = parseManagedCsiFileBoot(fixture.boot);
const nativeListen = Server.prototype.listen;
let worker: ManagedCsiFileWorkerHandle | undefined;
const headers = {
  authorization: `Bearer ${boot.context.token}`,
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': boot.context.leaseId,
  'x-qwen-managed-lease-epoch': String(boot.context.epoch),
};

beforeEach(() => {
  vi.stubEnv('QWEN_POD_UID', fixture.expectedPod.uid);
  vi.stubEnv('QWEN_POD_NAMESPACE', fixture.expectedPod.namespace);
  vi.stubEnv('QWEN_NODE_NAME', fixture.expectedPod.nodeName);
});
afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockMountFixture() {
  vi.spyOn(ManagedCsiMount.prototype, 'isAvailable', 'get').mockReturnValue(
    true,
  );
  const observe = vi
    .spyOn(ManagedCsiMount.prototype, 'observe')
    .mockResolvedValue(fixture.attestationResponse.mount);
  const close = vi
    .spyOn(ManagedCsiMount.prototype, 'close')
    .mockResolvedValue();
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
    this: Server,
  ) {
    return Reflect.apply(nativeListen, this, [0, '127.0.0.1']) as Server;
  });
  return { observe, close };
}
function send(
  route: string,
  body: unknown,
  override: Record<string, string> = {},
) {
  return fetch(
    `${worker!.ready.context.url}${route.startsWith('/') ? route : `${MANAGED_CSI_FILE_PREFIX}/${route}`}`,
    {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(body),
    },
  );
}

describe('CSI2 production construction with labelled mock Linux mount', () => {
  it.each([boot, parseManagedCsiFileBoot(fixture.executionBoot5)])(
    'serves only four exact routes for boot$version and installs the fixed context without any tools',
    async (candidate) => {
      mockMountFixture();
      const generic = vi
        .spyOn(contextWorker, 'registerManagedContextRoutes')
        .mockImplementation(() => {
          throw new Error('Generic factory forbidden');
        });
      const tools = vi
        .spyOn(ManagedToolExecutor, 'forWorkspace')
        .mockImplementation(() => {
          throw new Error('Tool construction forbidden');
        });
      const compose = vi
        .spyOn(composer, 'composeManagedCsiFiles')
        .mockImplementation(() => {
          throw new Error('History construction forbidden');
        });
      worker = await startManagedRuntimeAttestationWorker(
        candidate,
        undefined,
        undefined,
        true,
      );
      expect(worker.ready.version).toBe(candidate.version);
      expect(worker.ready).not.toHaveProperty('authority');
      const attest = await send(
        'context-attest',
        fixture.contextAttestationRequest,
      );
      expect(attest.status).toBe(200);
      expect(attest.headers.get('x-qwen-managed-runtime-incarnation')).toBe(
        boot.context.runtimeIncarnation,
      );
      expect(attest.headers.get('cache-control')).toBe('no-store');
      expect(await attest.json()).toEqual(fixture.contextAttestationResponse);
      expect(
        await (await send('attest', fixture.attestationRequest)).json(),
      ).toEqual(fixture.attestationResponse);
      for (let index = 0; index < 2; index++)
        expect(
          await (await send('context', fixture.installationRequest)).json(),
        ).toEqual(fixture.installationResponse);
      for (const route of [
        '/internal/managed-runtime/v3/execute',
        '/internal/managed-runtime/v3/context',
        '/internal/managed-runtime/csi/v1/acknowledge',
        '/internal/managed-runtime/csi/v1/attest',
        '/internal/managed-runtime/v3/provider',
        `${MANAGED_CSI_FILE_PREFIX}/context?alias=1`,
        `${MANAGED_CSI_FILE_PREFIX}/acknowledge`,
        `${MANAGED_CSI_FILE_PREFIX}/history`,
      ])
        expect((await send(route, {})).status).toBe(404);
      expect(
        (
          await fetch(
            `${worker.ready.context.url}${MANAGED_CSI_FILE_PREFIX}/attest`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await send('attest', fixture.attestationRequest, {
            authorization: 'Bearer other',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await send('attest', fixture.attestationRequest, {
            'x-qwen-managed-lease-epoch': '99',
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await send('attest', fixture.attestationRequest, {
            'cache-control': 'max-age=1',
          })
        ).status,
      ).toBe(400);
      expect(generic).not.toHaveBeenCalled();
      expect(tools).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
    },
  );

  it('rejects crossed owner, configuration, context revision and ambiguous JSON', async () => {
    mockMountFixture();
    worker = await startManagedRuntimeAttestationWorker(
      boot,
      undefined,
      undefined,
      true,
    );
    const original = fixture.installationRequest.context;
    for (const context of [
      { ...original, sessionId: 'd911c54f-ad76-420f-8c76-fb124c0ce623' },
      { ...original, binding: { ...original.binding, cwdRelative: 'child' } },
      {
        ...original,
        binding: { ...original.binding, contextConfigRef: 'foreign' },
      },
    ])
      expect(
        (await send('context', { ...fixture.installationRequest, context }))
          .status,
      ).toBe(409);
    expect((await send('context', fixture.installationRequest)).status).toBe(
      200,
    );
    const binding = { ...original.binding, contextRevision: '2' };
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: {
            ...original,
            binding,
            contextDigest: computeManagedContextDigest(binding),
          },
        })
      ).status,
    ).toBe(409);
    for (const body of [
      '{"protocolVersion":2,"protocolVersion":2}',
      '{} {}',
      '{"protocolVersion":2.0}',
    ])
      expect(
        (
          await fetch(
            `${worker.ready.context.url}${MANAGED_CSI_FILE_PREFIX}/attest`,
            { method: 'POST', headers, body },
          )
        ).status,
      ).toBe(400);
    expect((await send('attest', { huge: 'x'.repeat(20000) })).status).toBe(
      413,
    );
  });

  it('seals a pending installation and refuses retries while retaining the original retirement ID', async () => {
    const mount = mockMountFixture();
    worker = await startManagedRuntimeAttestationWorker(
      boot,
      undefined,
      undefined,
      true,
    );
    let release!: () => void;
    let started!: () => void;
    const observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    mount.observe.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fixture.attestationResponse.mount;
    });
    const installing = send('context', fixture.installationRequest);
    await observed;
    expect(
      (await send('drain', { ...fixture.drainRequest, operation: 'status' }))
        .status,
    ).toBe(409);
    expect(await (await send('drain', fixture.drainRequest)).json()).toEqual(
      fixture.drainResponse,
    );
    release();
    expect((await installing).status).toBe(409);
    expect((await send('context', fixture.installationRequest)).status).toBe(
      409,
    );
    expect(
      (
        await send('drain', {
          ...fixture.drainRequest,
          retirementId: 'e911c54f-ad76-420f-8c76-fb124c0ce623',
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await send('drain', { ...fixture.drainRequest, operation: 'status' })
      ).json(),
    ).toEqual(fixture.drainResponse);
    expect((await send('attest', fixture.attestationRequest)).status).toBe(200);
  });

  it('joins one original close promise and cleans up on observation/listener failure', async () => {
    const mount = mockMountFixture();
    worker = await startManagedRuntimeAttestationWorker(
      boot,
      undefined,
      undefined,
      true,
    );
    let release!: () => void;
    mount.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = worker.close();
    const second = worker.close();
    expect(second).toBe(first);
    let closed = false;
    void first.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await first;
    expect(mount.close).toHaveBeenCalledTimes(1);
    worker = undefined;
    mount.close.mockResolvedValue();
    mount.observe.mockRejectedValueOnce(
      new Error('Original mount unavailable'),
    );
    await expect(
      startManagedRuntimeAttestationWorker(boot, undefined, undefined, true),
    ).rejects.toThrow('Original mount unavailable');
    expect(mount.close).toHaveBeenCalledTimes(2);
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (
      this: Server,
    ) {
      queueMicrotask(() =>
        this.emit('error', new Error('Listener unavailable')),
      );
      return this;
    });
    await expect(
      startManagedRuntimeAttestationWorker(boot, undefined, undefined, true),
    ).rejects.toThrow('Listener unavailable');
    expect(mount.close).toHaveBeenCalledTimes(3);
  });
});

it.each([boot, parseManagedCsiFileBoot(fixture.executionBoot5)])(
  'accepts exact boot$version only at container reader and refuses local/stale/incomplete identity before mount',
  async (candidate) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'csi-file-boot-'));
    try {
      const file = path.join(directory, 'boot.json');
      await writeFile(file, JSON.stringify(candidate));
      expect(await readManagedRuntimeContainerBoot(file)).toEqual(candidate);
      await expect(
        readManagedRuntimeWorkerBoot(
          Readable.from([JSON.stringify(candidate)]),
        ),
      ).rejects.toThrow();
      const observe = vi.spyOn(ManagedCsiMount.prototype, 'observe');
      await expect(
        startManagedRuntimeAttestationWorker(candidate),
      ).rejects.toThrow();
      vi.stubEnv('QWEN_POD_UID', 'foreign');
      await expect(
        startManagedRuntimeAttestationWorker(
          candidate,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toThrow();
      expect(observe).not.toHaveBeenCalled();
      await writeFile(
        file,
        JSON.stringify(candidate).replace(
          `"version":${candidate.version}`,
          `"version":${candidate.version},"version":${candidate.version}`,
        ),
      );
      await expect(readManagedRuntimeContainerBoot(file)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
