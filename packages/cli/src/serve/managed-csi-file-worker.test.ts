/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
import * as nativeReadback from './managed-csi-native-readback.js';
import * as finalization from './managed-csi-file-finalize-protocol.js';
import {
  CSI_FILE_HISTORY_PATH,
  type CsiFileHistoryObservation,
} from './managed-csi-file-history-protocol.js';
import { ManagedToolExecutor } from './managed-runtime-tool-executor.js';
import { ManagedMonitorRegistry } from './managed-monitor-registry.js';
import * as historyProtocol from './managed-csi-file-history-protocol.js';
import type { ManagedCsiFileWorkerHandle } from './managed-csi-file-worker.js';
import {
  csiHistoryPreparationFixture,
  csiFileHistoryEnvelope,
} from './__tests__/csi-history-preparation-fixture.js';
import {
  computeManagedContextDigest,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';

const nativeFixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-native-readback-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const fixture = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-csi-files-v2.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
  boot: unknown;
  executionBoot5: unknown;
  finalizationBoot6: unknown;
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

describe('boot6 finalization HTTP with labelled Linux/composer and saved-cut seams', () => {
  const candidate = parseManagedCsiFileBoot(fixture.finalizationBoot6);
  const installed = nativeFixture.valid[0].request.installedContext;
  const observation = {
    history: {
      ownerSessionId: candidate.identity.sessionId,
      snapshots: [],
      files: {},
    },
    storage: {
      backupDirectory: {
        volumeDevice: '1',
        volumeInode: '2',
        directoryDevice: '1',
        directoryInode: '3',
      },
      retainedBackups: [],
    },
  };
  const observeRequest = () =>
    finalization.csiFileFinalizeRequest(
      candidate,
      installed,
      fixture.expectedPod,
      fixture.attestationResponse.mount,
      {
        operation: 'observe',
        retirementId: fixture.drainRequest.retirementId,
        preparedCommitSha256: 'a'.repeat(64),
        frozenRequestSha256: null,
        cutSha256: null,
      },
    );
  const finalizeRequest = () => ({
    ...observeRequest(),
    operation: 'finalize',
    frozenRequestSha256: 'b'.repeat(64),
    cutSha256: 'c'.repeat(64),
  });
  async function startBound() {
    mockMountFixture();
    const observe = vi.fn().mockResolvedValue(observation);
    const inventory = vi.fn().mockResolvedValue({
      history: observation.history,
      backend: { retained: observation.storage },
      mount: { pendingOperations: 0 },
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const inspection = vi.fn().mockResolvedValue({
      compositionClosed: true,
      backend: {
        closed: true,
        blocked: false,
        pendingOperations: 0,
        openDescriptors: [],
      },
      mount: {
        admissionClosed: true,
        pendingOperations: 0,
        closeFailed: false,
        root: {
          admissionClosed: true,
          pendingOperations: 0,
          fd: null,
          device: fixture.attestationResponse.mount.rootDevice,
          inode: fixture.attestationResponse.mount.rootInode,
        },
      },
    });
    vi.spyOn(composer, 'composeManagedCsiFiles').mockResolvedValue({
      observe,
      close,
      history: { prepare: vi.fn() },
      retirementInventory: inventory,
      retirementCloseInspection: inspection,
    } as unknown as Awaited<
      ReturnType<typeof composer.composeManagedCsiFiles>
    >);
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValue(nativeFixture.valid[0].response);
    worker = await startManagedRuntimeAttestationWorker(
      candidate,
      undefined,
      undefined,
      true,
    );
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: installed,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          CSI_FILE_HISTORY_PATH,
          csiFileHistoryEnvelope(candidate, installed, {
            kind: 'csi-file-history',
            version: 1,
            action: 'bind',
          }),
        )
      ).status,
    ).toBe(200);
    return { observe, inventory, close, inspection, native };
  }

  it.each([fixture.boot, fixture.executionBoot5])(
    'keeps the finalize route unavailable for original boot$version',
    async (oldBoot) => {
      mockMountFixture();
      worker = await startManagedRuntimeAttestationWorker(
        parseManagedCsiFileBoot(oldBoot),
        undefined,
        undefined,
        true,
      );
      expect((await send(finalization.CSI_FILE_FINALIZE_PATH, {})).status).toBe(
        404,
      );
    },
  );

  it('closes admission before joining an accepted snapshot and caches exact observation bytes', async () => {
    const retained = await startBound();
    let resume!: () => void;
    retained.observe.mockImplementationOnce(
      () => new Promise((resolve) => (resume = () => resolve(observation))),
    );
    const snapshot = send(
      CSI_FILE_HISTORY_PATH,
      csiFileHistoryEnvelope(candidate, installed, {
        kind: 'csi-file-history',
        version: 1,
        action: 'snapshot',
      }),
    );
    await vi.waitFor(() => expect(retained.observe).toHaveBeenCalledTimes(2));
    const seal = vi.spyOn(ManagedToolExecutor.prototype, 'sealAdmission');
    const observing = send(
      finalization.CSI_FILE_FINALIZE_PATH,
      observeRequest(),
    );
    await vi.waitFor(() => expect(seal).toHaveBeenCalled());
    expect(retained.inventory).not.toHaveBeenCalled();
    expect((await send('context', fixture.installationRequest)).status).toBe(
      409,
    );
    expect((await send('attest', fixture.attestationRequest)).status).toBe(409);
    expect(
      (await send('context-attest', fixture.contextAttestationRequest)).status,
    ).toBe(409);
    resume();
    expect((await snapshot).status).toBe(200);
    const response = await observing;
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(JSON.parse(bytes).state).toBe('FROZEN_CANDIDATE');
    expect(
      await (
        await send(finalization.CSI_FILE_FINALIZE_PATH, observeRequest())
      ).text(),
    ).toBe(bytes);
    expect(retained.inventory).toHaveBeenCalledTimes(1);
    expect(retained.close).not.toHaveBeenCalled();
    expect(
      (
        await send(finalization.CSI_FILE_FINALIZE_PATH, {
          ...observeRequest(),
          preparedCommitSha256: 'e'.repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(retained.native).toHaveBeenCalledTimes(1);
  });

  it('requires saved CUT before cleanup and returns the first exact receipt on retry', async () => {
    const retained = await startBound();
    const pre = await send(
      finalization.CSI_FILE_FINALIZE_PATH,
      observeRequest(),
    );
    const preBytes = await pre.text();
    const saved = vi
      .spyOn(finalization, 'requireSavedCsiApplicationCut')
      .mockImplementation(async () => {
        expect(retained.close).not.toHaveBeenCalled();
      });
    const first = await send(
      finalization.CSI_FILE_FINALIZE_PATH,
      finalizeRequest(),
    );
    expect(first.status).toBe(200);
    const receipt = await first.text();
    expect(JSON.parse(receipt)).toMatchObject({
      state: 'DRAINED',
      preCutObservationSha256: createHash('sha256')
        .update(preBytes)
        .digest('hex'),
    });
    expect(saved).toHaveBeenCalledExactlyOnceWith(
      candidate,
      finalizeRequest(),
      createHash('sha256').update(preBytes).digest('hex'),
    );
    expect(retained.close).toHaveBeenCalledTimes(1);
    expect(retained.inspection).toHaveBeenCalledTimes(1);
    expect(
      await (
        await send(finalization.CSI_FILE_FINALIZE_PATH, finalizeRequest())
      ).text(),
    ).toBe(receipt);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(retained.close).toHaveBeenCalledTimes(1);
    expect(
      (
        await send(finalization.CSI_FILE_FINALIZE_PATH, {
          ...finalizeRequest(),
          cutSha256: 'd'.repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(retained.native).toHaveBeenCalledTimes(1);
  });

  it.each(['backup inode changed', 'backup membership grew'])(
    'refuses finalization when %s after the frozen observation',
    async (fault) => {
      const retained = await startBound();
      expect(
        (await send(finalization.CSI_FILE_FINALIZE_PATH, observeRequest()))
          .status,
      ).toBe(200);
      const saved = vi
        .spyOn(finalization, 'requireSavedCsiApplicationCut')
        .mockResolvedValue();
      retained.inventory.mockResolvedValue({
        history: observation.history,
        backend: {
          retained:
            fault === 'backup inode changed'
              ? {
                  ...observation.storage,
                  backupDirectory: {
                    ...observation.storage.backupDirectory,
                    directoryInode: '99',
                  },
                }
              : {
                  ...observation.storage,
                  retainedBackups: [{ unexpected: true }],
                },
        },
        mount: { pendingOperations: 0 },
      });
      for (let retry = 0; retry < 2; retry++)
        expect(
          (await send(finalization.CSI_FILE_FINALIZE_PATH, finalizeRequest()))
            .status,
        ).toBe(409);
      expect(saved).toHaveBeenCalledTimes(1);
      expect(retained.inventory).toHaveBeenCalledTimes(2);
      expect(retained.close).not.toHaveBeenCalled();
      expect(retained.inspection).not.toHaveBeenCalled();
      await expect(worker!.close()).rejects.toThrow('worker close failed');
      worker = undefined;
    },
  );

  it('refuses changed executor state even when it remains quiescent', async () => {
    const retained = await startBound();
    const pre = await send(
      finalization.CSI_FILE_FINALIZE_PATH,
      observeRequest(),
    );
    expect(pre.status).toBe(200);
    const frozen = (await pre.json()) as {
      execution: Awaited<
        ReturnType<ManagedToolExecutor['csiRetirementInventory']>
      >;
    };
    vi.spyOn(finalization, 'requireSavedCsiApplicationCut').mockResolvedValue();
    const inventory = vi
      .spyOn(ManagedToolExecutor.prototype, 'csiRetirementInventory')
      .mockResolvedValue({
        ...frozen.execution,
        secondary: { ...frozen.execution.secondary, providerUsed: true },
      });
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await send(finalization.CSI_FILE_FINALIZE_PATH, finalizeRequest()))
          .status,
      ).toBe(409);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(retained.close).not.toHaveBeenCalled();
    expect(retained.inspection).not.toHaveBeenCalled();
    await expect(worker!.close()).rejects.toThrow('worker close failed');
    worker = undefined;
  });

  it('retains a saved-cut refusal without cleanup or a replacement retry', async () => {
    const retained = await startBound();
    expect(
      (await send(finalization.CSI_FILE_FINALIZE_PATH, observeRequest()))
        .status,
    ).toBe(200);
    const saved = vi
      .spyOn(finalization, 'requireSavedCsiApplicationCut')
      .mockRejectedValue(new Error('No saved CUT'));
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await send(finalization.CSI_FILE_FINALIZE_PATH, finalizeRequest()))
          .status,
      ).toBe(409);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(retained.close).not.toHaveBeenCalled();
    await expect(worker!.close()).rejects.toThrow('worker close failed');
    worker = undefined;
  });

  it('refuses a failed executor close even when its registry has no retained activity', async () => {
    const retained = await startBound();
    expect(
      (await send(finalization.CSI_FILE_FINALIZE_PATH, observeRequest()))
        .status,
    ).toBe(200);
    vi.spyOn(finalization, 'requireSavedCsiApplicationCut').mockResolvedValue();
    const stopped = vi
      .spyOn(ManagedMonitorRegistry.prototype, 'stopAll')
      .mockRejectedValue(new Error('Monitor close failed'));
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await send(finalization.CSI_FILE_FINALIZE_PATH, finalizeRequest()))
          .status,
      ).toBe(409);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(retained.close).not.toHaveBeenCalled();
    expect(retained.inspection).not.toHaveBeenCalled();
    await expect(worker!.close()).rejects.toThrow('worker close failed');
    worker = undefined;
  });

  it('retains failures after completed operations leave the pending set', async () => {
    const retained = await startBound();
    retained.observe.mockRejectedValueOnce(new Error('Snapshot failed'));
    expect(
      (
        await send(
          CSI_FILE_HISTORY_PATH,
          csiFileHistoryEnvelope(candidate, installed, {
            kind: 'csi-file-history',
            version: 1,
            action: 'snapshot',
          }),
        )
      ).status,
    ).toBe(409);
    for (let retry = 0; retry < 2; retry++)
      expect(
        (await send(finalization.CSI_FILE_FINALIZE_PATH, observeRequest()))
          .status,
      ).toBe(409);
    expect(retained.inventory).not.toHaveBeenCalled();
    expect(retained.close).not.toHaveBeenCalled();
    await expect(worker!.close()).rejects.toThrow('worker close failed');
    worker = undefined;
  });
});

describe('CSI2 production construction with labelled mock Linux mount', () => {
  it.each([
    boot,
    parseManagedCsiFileBoot(fixture.executionBoot5),
    parseManagedCsiFileBoot(fixture.finalizationBoot6),
  ])(
    'serves the boot$version construction routes and installs the fixed context without constructing tools',
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
      expect(Server.prototype.listen).toHaveBeenCalledWith(43190, '0.0.0.0');
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
          await (
            await send(
              'context',
              candidate.version === 5 || candidate.version === 6
                ? {
                    ...fixture.installationRequest,
                    context: nativeFixture.valid[0].request.installedContext,
                  }
                : fixture.installationRequest,
            )
          ).json(),
        ).toEqual(
          candidate.version === 5 || candidate.version === 6
            ? {
                ...(fixture.installationResponse as Record<string, unknown>),
                context: {
                  ...(
                    fixture.installationResponse as {
                      context: Record<string, unknown>;
                    }
                  ).context,
                  operationId:
                    nativeFixture.valid[0].request.installedContext.operationId,
                },
              }
            : fixture.installationResponse,
        );
      for (const route of [
        '/internal/managed-runtime/v3/execute',
        '/internal/managed-runtime/v3/context',
        '/internal/managed-runtime/csi/v1/acknowledge',
        '/internal/managed-runtime/csi/v1/attest',
        '/internal/managed-runtime/v3/provider',
        `${MANAGED_CSI_FILE_PREFIX}/context?alias=1`,
        `${MANAGED_CSI_FILE_PREFIX}/acknowledge`,
        `${MANAGED_CSI_FILE_PREFIX}/history`,
        ...(candidate.version === 4
          ? [CSI_FILE_HISTORY_PATH, `${MANAGED_CSI_FILE_PREFIX}/execute`]
          : []),
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
    await vi.waitFor(() => expect(mount.close).toHaveBeenCalledTimes(1));
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

describe('boot5 history HTTP ownership with labelled readback/composer seams', () => {
  const candidate = parseManagedCsiFileBoot(nativeFixture.boot);
  const installed = nativeFixture.valid[0].request.installedContext;
  const observation: CsiFileHistoryObservation = {
    state: {
      ownerSessionId: candidate.identity.sessionId,
      snapshots: [],
      files: {},
    },
    backupDirectory: {
      volumeDevice: '1',
      volumeInode: '2',
      directoryDevice: '1',
      directoryInode: '3',
    },
    retainedBackups: [],
  };
  async function start() {
    worker = await startManagedRuntimeAttestationWorker(
      candidate,
      undefined,
      undefined,
      true,
    );
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: installed,
        })
      ).status,
    ).toBe(200);
  }
  function history(action: 'bind' | 'snapshot') {
    return send(
      CSI_FILE_HISTORY_PATH,
      csiFileHistoryEnvelope(candidate, installed, {
        kind: 'csi-file-history',
        version: 1,
        action,
      }),
    );
  }
  function prepare(
    ref: ReturnType<typeof csiHistoryPreparationFixture>['intentRef'],
  ) {
    return send(
      CSI_FILE_HISTORY_PATH,
      csiFileHistoryEnvelope(candidate, installed, {
        kind: 'csi-file-history',
        version: 1,
        action: 'prepare',
        preparationRef: ref,
      }),
    );
  }
  function retainedHistory(
    sample: ReturnType<typeof csiHistoryPreparationFixture>,
  ) {
    const observe = vi.fn().mockResolvedValue({
      history: sample.observation.state,
      storage: {
        backupDirectory: sample.observation.backupDirectory,
        retainedBackups: sample.observation.retainedBackups,
      },
    });
    const historyPrepare = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const compose = vi
      .spyOn(composer, 'composeManagedCsiFiles')
      .mockResolvedValue({
        observe,
        close,
        history: { prepare: historyPrepare },
      } as unknown as Awaited<
        ReturnType<typeof composer.composeManagedCsiFiles>
      >);
    return { observe, historyPrepare, close, compose };
  }

  it('refuses invalid first revisions and reinstall keys before replacing the canonical context', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    retainedHistory(sample);
    vi.spyOn(nativeReadback, 'readCurrentCsiNative').mockResolvedValue(
      nativeFixture.valid[0].response,
    );
    worker = await startManagedRuntimeAttestationWorker(
      candidate,
      undefined,
      undefined,
      true,
    );
    const revised = { ...installed.binding, contextRevision: '2' };
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: {
            ...installed,
            binding: revised,
            contextDigest: computeManagedContextDigest(revised),
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: installed,
        })
      ).status,
    ).toBe(200);
    expect((await history('bind')).status).toBe(200);
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: { ...installed, operationId: randomUUID() },
        })
      ).status,
    ).toBe(409);
    expect((await history('snapshot')).status).toBe(200);
    expect(
      (
        await send('context', {
          ...fixture.installationRequest,
          context: installed,
        })
      ).status,
    ).toBe(200);
    expect((await history('bind')).status).toBe(200);
  });

  it('retries bind authority failure before composing any history', async () => {
    mockMountFixture();
    const retained = retainedHistory(csiHistoryPreparationFixture());
    const read = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockRejectedValueOnce(new Error('Authority unavailable'))
      .mockResolvedValue(nativeFixture.valid[0].response);
    await start();
    expect((await history('bind')).status).toBe(409);
    expect(retained.compose).not.toHaveBeenCalled();
    expect((await history('bind')).status).toBe(200);
    expect(retained.compose).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retries the same prepare reference only while no preimage effects have started', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockRejectedValueOnce(new Error('Authority unavailable'))
      .mockResolvedValue(sample.response);
    await start();
    expect((await history('bind')).status).toBe(200);
    expect((await prepare(sample.intentRef)).status).toBe(409);
    expect(retained.historyPrepare).not.toHaveBeenCalled();
    expect((await prepare(sample.intentRef)).status).toBe(200);
    expect((await prepare(sample.intentRef)).status).toBe(200);
    expect(retained.historyPrepare).toHaveBeenCalledTimes(1);
  });

  it('refuses projected history capacity before effects and still serves the original snapshot', async () => {
    mockMountFixture();
    const initial = structuredClone(observation);
    const timestamp = new Date().toISOString();
    const tracked = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `file-${i}.txt`,
        { backupFileName: null, version: 1, backupTime: timestamp },
      ]),
    );
    initial.state.snapshots = [
      { promptId: randomUUID(), timestamp, trackedFileBackups: tracked },
    ];
    initial.state.files = Object.fromEntries(
      Object.keys(tracked).map((file) => [file, null]),
    );
    const sample = csiHistoryPreparationFixture(initial);
    const retained = retainedHistory(csiHistoryPreparationFixture());
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockResolvedValue(sample.response);
    await start();
    expect((await history('bind')).status).toBe(200);
    retained.observe.mockResolvedValue({
      history: initial.state,
      storage: {
        backupDirectory: initial.backupDirectory,
        retainedBackups: [],
      },
    });
    const response = await prepare(sample.intentRef);
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty(
      'code',
      'managed_csi_history_capacity_exceeded',
    );
    expect(retained.historyPrepare).not.toHaveBeenCalled();
    const snapshot = await history('snapshot');
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toHaveProperty('observation', initial);
  });

  it('keeps preparation input errors retryable when history and storage are unchanged', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    retained.historyPrepare.mockRejectedValueOnce(
      Object.assign(new Error('Directory target'), { code: 'EISDIR' }),
    );
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockResolvedValue(sample.response);
    await start();
    expect((await history('bind')).status).toBe(200);
    expect((await prepare(sample.intentRef)).status).toBe(409);
    expect((await history('snapshot')).status).toBe(200);
    expect((await prepare(sample.intentRef)).status).toBe(200);
  });

  function readExecutionFixture() {
    const sample = structuredClone(nativeFixture.valid[3]);
    const payloadJson = JSON.stringify({
      toolName: 'read_file',
      input: { file_path: 'note.txt', offset: 0 },
    });
    const bytes = Buffer.from(
      JSON.stringify({
        harnessSessionId: candidate.identity.sessionId,
        runtimeSessionId: candidate.identity.sessionId,
        payloadJson,
      }),
    );
    const evidence = sample.response.evidence;
    evidence.executionReference.argsDigest = `sha256:${createHash('sha256').update(payloadJson).digest('hex')}`;
    evidence.executionReference.inputRef.byteLength = bytes.length;
    evidence.executionReference.inputRef.digest = createHash('sha256')
      .update(bytes)
      .digest('hex');
    evidence.grant.executionReference = structuredClone(
      evidence.executionReference,
    );
    evidence.resources[0] = {
      reference: evidence.executionReference.inputRef,
      bytesBase64: bytes.toString('base64'),
    };
    return sample;
  }

  it.each(['new request', 'pending readback'])(
    'refuses %s during preparation without retiring the retained owner',
    async (timing) => {
      mockMountFixture();
      const preparation = csiHistoryPreparationFixture();
      const retained = retainedHistory(preparation);
      const read = readExecutionFixture();
      let releasePreparation!: () => void;
      const preparing = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      retained.historyPrepare.mockImplementation(() => preparing);
      let releaseReadback!: () => void;
      const readback = new Promise<void>((resolve) => {
        releaseReadback = resolve;
      });
      const native = vi
        .spyOn(nativeReadback, 'readCurrentCsiNative')
        .mockImplementation(async (_boot, _installed, action) => {
          if (action === 'execute' && timing === 'pending readback')
            await readback;
          return (action === 'bind'
            ? nativeFixture.valid[0].response
            : action === 'prepare'
              ? preparation.response
              : read.response) as unknown as Awaited<
            ReturnType<typeof nativeReadback.readCurrentCsiNative>
          >;
        });
      const execute = vi
        .spyOn(ManagedToolExecutor.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'owned Read result' }],
        });
      await start();
      expect((await history('bind')).status).toBe(200);
      let reading: Promise<Response> | undefined;
      let preparingRequest: Promise<Response> | undefined;
      let response: Response;
      let executionsDuringPreparation: number;
      try {
        if (timing === 'pending readback') {
          reading = send('execute', read.request);
          await vi.waitFor(() =>
            expect(native).toHaveBeenCalledWith(
              candidate,
              installed,
              'execute',
              read.request.subject,
            ),
          );
        }
        preparingRequest = prepare(preparation.intentRef);
        await vi.waitFor(() =>
          expect(retained.historyPrepare).toHaveBeenCalledTimes(1),
        );
        reading ??= send('execute', read.request);
        releaseReadback();
        response = await reading;
        executionsDuringPreparation = execute.mock.calls.length;
      } finally {
        releaseReadback();
        releasePreparation();
      }
      expect((await preparingRequest!).status).toBe(200);
      expect(response!.status).toBe(409);
      expect(executionsDuringPreparation!).toBe(0);
      expect((await send('execute', read.request)).status).toBe(200);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await history('snapshot')).status).toBe(200);
      expect((await prepare(preparation.intentRef)).status).toBe(200);
      expect(retained.historyPrepare).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses preparation before preimage effects while an execution is active and permits the same retry', async () => {
    mockMountFixture();
    const preparation = csiHistoryPreparationFixture();
    const retained = retainedHistory(preparation);
    const read = readExecutionFixture();
    vi.spyOn(nativeReadback, 'readCurrentCsiNative').mockImplementation(
      async (_boot, _installed, action) =>
        (action === 'bind'
          ? nativeFixture.valid[0].response
          : action === 'prepare'
            ? preparation.response
            : read.response) as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >,
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi
      .spyOn(ManagedToolExecutor.prototype, 'execute')
      .mockImplementation(async () => {
        await pending;
        return {
          executionStatus: 'success',
          responseParts: [{ text: 'owned Read result' }],
        };
      });
    await start();
    expect((await history('bind')).status).toBe(200);
    const reading = send('execute', read.request);
    let response: Response;
    let preimagesBeforeRetry: number;
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      response = await prepare(preparation.intentRef);
      preimagesBeforeRetry = retained.historyPrepare.mock.calls.length;
    } finally {
      release();
    }
    expect((await reading).status).toBe(200);
    expect(response!.status).toBe(409);
    expect(preimagesBeforeRetry!).toBe(0);
    expect((await prepare(preparation.intentRef)).status).toBe(200);
    expect(retained.historyPrepare).toHaveBeenCalledTimes(1);
    expect((await history('snapshot')).status).toBe(200);
  });

  it('uses fresh original Read input on the private execute route with labelled authority/executor seams', async () => {
    mockMountFixture();
    retainedHistory(csiHistoryPreparationFixture());
    const sample = readExecutionFixture();
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockResolvedValueOnce(sample.response)
      .mockRejectedValue(new Error('Original authorization changed'));
    const result = {
      executionStatus: 'success' as const,
      responseParts: [{ text: 'owned Read result' }],
    };
    const execute = vi
      .spyOn(ManagedToolExecutor.prototype, 'execute')
      .mockResolvedValue(result);
    await start();
    expect((await history('bind')).status).toBe(200);
    const response = await send('execute', sample.request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...sample.request,
      state: 'settled',
      result,
    });
    const reference = sample.response.evidence.executionReference;
    const wrapper = JSON.parse(
      Buffer.from(
        sample.response.evidence.resources[0].bytesBase64,
        'base64',
      ).toString(),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: reference.sessionId,
        promptId: reference.promptId,
        callId: reference.callId,
        argsDigest: reference.argsDigest,
      },
      'read_file',
      JSON.parse(wrapper.payloadJson).input,
    );
    expect((await send('execute', sample.request)).status).toBe(409);
    expect(native).toHaveBeenLastCalledWith(
      candidate,
      installed,
      'execute',
      sample.request.subject,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('delivers settled results above 64 KiB within the executor result budget', async () => {
    mockMountFixture();
    retainedHistory(csiHistoryPreparationFixture());
    const sample = readExecutionFixture();
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockResolvedValue(sample.response);
    const result = {
      executionStatus: 'success' as const,
      responseParts: [{ text: '中'.repeat(25000) }],
    };
    vi.spyOn(ManagedToolExecutor.prototype, 'execute').mockResolvedValue(
      result,
    );
    await start();
    expect((await history('bind')).status).toBe(200);
    for (let retry = 0; retry < 2; retry++) {
      const response = await send('execute', sample.request);
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('result', result);
    }
  });

  it.each(['write_file', 'edit'])(
    'requires the cached original preparation for %s and keeps it after earlier file changes with labelled seams',
    async (toolName) => {
      mockMountFixture();
      const preparation = csiHistoryPreparationFixture();
      const retained = retainedHistory(preparation);
      const index = toolName === 'write_file' ? 1 : 2;
      const references = preparation.response.evidence['members'] as Array<
        Record<string, unknown>
      >;
      const reference = references[index];
      const preparedBody = {
        schemaVersion: 2,
        profile: candidate.identity.profile,
        runtimeSessionId: candidate.identity.sessionId,
        ...preparation.observation,
        preparation: {
          ...preparation.preparation,
          stage: 'prepared',
          intentRef: preparation.intentRef,
        },
      };
      const bytes = Buffer.from(JSON.stringify(preparedBody));
      const preparedRef = {
        resourceId: randomUUID(),
        kind: 'managed-file_history',
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
      const request = {
        ...nativeFixture.valid[3].request,
        subject: preparation.preparation.invocations[index].executionCallId,
      };
      const response = {
        ...nativeFixture.valid[3].response,
        subject: request.subject,
        evidence: {
          ...nativeFixture.valid[3].response.evidence,
          executionReference: reference,
          preparedRef,
          resources: [
            ...(
              preparation.response.evidence['resources'] as Array<{
                reference: { resourceId: string };
                bytesBase64: string;
              }>
            ).filter((resource) =>
              [
                preparation.preparation.invocations[index].inputRef.resourceId,
                preparation.preparation.invocations[index].toolDefinitionRef
                  .resourceId,
              ].includes(resource.reference.resourceId),
            ),
            { reference: preparedRef, bytesBase64: bytes.toString('base64') },
          ],
        },
      };
      vi.spyOn(nativeReadback, 'readCurrentCsiNative').mockImplementation(
        async (_boot, _installed, action) =>
          (action === 'bind'
            ? nativeFixture.valid[0].response
            : action === 'prepare'
              ? preparation.response
              : response) as unknown as Awaited<
            ReturnType<typeof nativeReadback.readCurrentCsiNative>
          >,
      );
      const execute = vi
        .spyOn(ManagedToolExecutor.prototype, 'execute')
        .mockResolvedValue({
          executionStatus: 'success',
          responseParts: [{ text: 'owned result' }],
        });
      await start();
      expect((await history('bind')).status).toBe(200);
      expect((await send('execute', request)).status).toBe(409);
      expect(execute).not.toHaveBeenCalled();
      expect((await prepare(preparation.intentRef)).status).toBe(200);
      retained.observe.mockRejectedValue(
        new Error('Later working files already changed'),
      );
      expect((await send('execute', request)).status).toBe(200);
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: reference['sessionId'],
          promptId: reference['promptId'],
          callId: reference['callId'],
          argsDigest: reference['argsDigest'],
        },
        toolName,
        toolName === 'write_file'
          ? { file_path: 'new.txt', content: 'new bytes' }
          : { file_path: 'existing.txt', old_string: 'a', new_string: 'b' },
      );
    },
  );

  it('seals during fresh execution readback and joins it before closing without starting I/O', async () => {
    mockMountFixture();
    const retained = retainedHistory(csiHistoryPreparationFixture());
    const sample = nativeFixture.valid[3];
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockImplementation(async () => {
        await paused;
        return sample.response;
      });
    const execute = vi.spyOn(ManagedToolExecutor.prototype, 'execute');
    await start();
    expect((await history('bind')).status).toBe(200);
    const request = send('execute', sample.request).catch(() => undefined);
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    const closing = worker!.close();
    expect(retained.close).not.toHaveBeenCalled();
    resume();
    await closing;
    await request;
    worker = undefined;
    expect(execute).not.toHaveBeenCalled();
    expect(retained.close).toHaveBeenCalledTimes(1);
  });

  it('joins the original prepare promise and derives mutation paths from fresh native evidence', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(
        nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >,
      )
      .mockImplementation(async () => {
        await paused;
        return sample.response;
      });
    await start();
    expect((await history('bind')).status).toBe(200);
    const first = prepare(sample.intentRef);
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    const retry = prepare(sample.intentRef);
    resume();
    expect((await first).status).toBe(200);
    expect((await retry).status).toBe(200);
    expect(retained.historyPrepare).toHaveBeenCalledExactlyOnceWith(
      sample.preparation.promptId,
      ['existing.txt', 'new.txt'],
    );
    expect(retained.compose).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenLastCalledWith(
      candidate,
      installed,
      'prepare',
      sample.intentRef,
    );
    expect((await prepare(sample.intentRef)).status).toBe(200);
    expect(native).toHaveBeenCalledTimes(2);
    expect(
      (await prepare({ ...sample.intentRef, digest: 'a'.repeat(64) })).status,
    ).toBe(409);
    expect(retained.historyPrepare).toHaveBeenCalledTimes(1);
  });

  it('retains a failed prepare without recopying preimages on retries', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    retained.historyPrepare.mockImplementation(async () => {
      retained.observe.mockRejectedValueOnce(
        new Error('Retained effects cannot be accounted for'),
      );
      throw new Error('Owned backup failed');
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(
        nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >,
      )
      .mockResolvedValue(sample.response);
    await start();
    expect((await history('bind')).status).toBe(200);
    expect((await prepare(sample.intentRef)).status).toBe(409);
    expect((await prepare(sample.intentRef)).status).toBe(409);
    expect(retained.historyPrepare).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(2);
    const snapshot = await history('snapshot');
    expect(snapshot.status).toBe(409);
    expect(await snapshot.json()).toHaveProperty(
      'code',
      'managed_csi_history_retirement_required',
    );
    const drained = await (await send('drain', fixture.drainRequest)).json();
    expect(drained.workState).toBe('BLOCKED');
    expect(drained.blockers).toContain('history-prepare-failed');
  });

  it('refuses an already queued snapshot after an effectful prepare fails', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    let release!: () => void;
    retained.historyPrepare.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      retained.observe.mockRejectedValueOnce(
        new Error('Retained effects cannot be accounted for'),
      );
      throw new Error('Post-effect preparation failed');
    });
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(nativeFixture.valid[0].response)
      .mockResolvedValue(sample.response);
    const envelopes = vi.spyOn(historyProtocol, 'readCsiFileHistoryEnvelope');
    await start();
    expect((await history('bind')).status).toBe(200);
    const preparation = prepare(sample.intentRef);
    await vi.waitFor(() =>
      expect(retained.historyPrepare).toHaveBeenCalledTimes(1),
    );
    const snapshot = history('snapshot');
    await vi.waitFor(() => expect(envelopes).toHaveBeenCalledTimes(6));
    release();
    expect((await preparation).status).toBe(409);
    const response = await snapshot;
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty(
      'code',
      'managed_csi_history_retirement_required',
    );
  });

  it('refuses changed original observation before preimage I/O', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    vi.spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(
        nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >,
      )
      .mockResolvedValue(sample.response);
    await start();
    expect((await history('bind')).status).toBe(200);
    retained.observe.mockResolvedValue({
      history: sample.observation.state,
      storage: {
        backupDirectory: {
          ...sample.observation.backupDirectory,
          directoryInode: '99',
        },
        retainedBackups: [],
      },
    });
    expect((await prepare(sample.intentRef)).status).toBe(409);
    expect(retained.historyPrepare).not.toHaveBeenCalled();
  });

  it('seals and joins pending preparation readback before closing the original composition', async () => {
    mockMountFixture();
    const sample = csiHistoryPreparationFixture();
    const retained = retainedHistory(sample);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockResolvedValueOnce(
        nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >,
      )
      .mockImplementation(async () => {
        await paused;
        return sample.response;
      });
    await start();
    expect((await history('bind')).status).toBe(200);
    const request = prepare(sample.intentRef).catch(() => undefined);
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
    const closing = worker!.close();
    expect(retained.close).not.toHaveBeenCalled();
    resume();
    await closing;
    await request;
    worker = undefined;
    expect(retained.historyPrepare).not.toHaveBeenCalled();
    expect(retained.close).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent bind, waits before snapshot and observes the retained owner after seal', async () => {
    const mount = mockMountFixture();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockImplementation(async () => {
        await paused;
        return nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >;
      });
    const observe = vi.fn().mockResolvedValue({
      history: observation.state,
      storage: {
        backupDirectory: observation.backupDirectory,
        retainedBackups: [],
      },
    });
    let originalMount: ManagedCsiMount;
    const close = vi.fn(() => originalMount.close());
    const compose = vi
      .spyOn(composer, 'composeManagedCsiFiles')
      .mockImplementation(async (options) => {
        originalMount = options.mount;
        return { observe, close } as unknown as Awaited<
          ReturnType<typeof composer.composeManagedCsiFiles>
        >;
      });
    await start();
    const first = history('bind');
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    const retry = history('bind');
    const snapshot = history('snapshot');
    expect(compose).not.toHaveBeenCalled();
    resume();
    for (const response of await Promise.all([first, retry, snapshot])) {
      expect(response.status).toBe(200);
      expect((await response.json()).observation).toEqual(observation);
    }
    expect(native).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    const drain = await (await send('drain', fixture.drainRequest)).json();
    expect(drain.workState).toBe('BLOCKED');
    expect(drain.blockers).toContain('retained-history-bound');
    expect((await history('bind')).status).toBe(409);
    expect(
      (await prepare(csiHistoryPreparationFixture().intentRef)).status,
    ).toBe(409);
    expect((await send('execute', readExecutionFixture().request)).status).toBe(
      409,
    );
    expect(native).toHaveBeenCalledTimes(1);
    expect((await history('snapshot')).status).toBe(200);
    await worker!.close();
    worker = undefined;
    expect(close).toHaveBeenCalledTimes(1);
    expect(mount.close).toHaveBeenCalledTimes(1);
  });
  it('refuses every unavailable bind attempt without constructing history', async () => {
    mockMountFixture();
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockRejectedValue(new Error('Original native owner unavailable'));
    const compose = vi.spyOn(composer, 'composeManagedCsiFiles');
    await start();
    expect((await history('bind')).status).toBe(409);
    expect((await history('bind')).status).toBe(409);
    expect((await history('snapshot')).status).toBe(409);
    expect(native).toHaveBeenCalledTimes(2);
    expect(compose).not.toHaveBeenCalled();
  });
  it('close seals first and joins a pending native read before closing the original mount', async () => {
    const mount = mockMountFixture();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const native = vi
      .spyOn(nativeReadback, 'readCurrentCsiNative')
      .mockImplementation(async () => {
        await paused;
        return nativeFixture.valid[0].response as unknown as Awaited<
          ReturnType<typeof nativeReadback.readCurrentCsiNative>
        >;
      });
    const compose = vi.spyOn(composer, 'composeManagedCsiFiles');
    await start();
    const request = history('bind').catch(() => undefined);
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1));
    const closing = worker!.close();
    const result = closing.catch(() => undefined);
    await Promise.resolve();
    expect(mount.close).not.toHaveBeenCalled();
    resume();
    await result;
    await request;
    worker = undefined;
    expect(compose).not.toHaveBeenCalled();
    expect(mount.close).toHaveBeenCalledTimes(1);
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
