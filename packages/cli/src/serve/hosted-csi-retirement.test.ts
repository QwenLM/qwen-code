/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from './auth.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import { registerHostedCsiSessionRoutes } from './hosted-csi-session.js';

const components = vi.hoisted(() => ({
  stores: vi.fn(),
  open: vi.fn(),
  project: vi.fn(),
  bind: vi.fn(),
  initial: vi.fn(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  () => ({
    createHttpManagedSessionStores: components.stores,
    HTTP_MANAGED_SESSION_STORE_CONTRACT: { maxInlineResourceBytes: 64 * 1024 },
  }),
);
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js',
  () => ({
    LocalManagedSessionAuthority: { open: components.open },
  }),
);
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js',
  () => ({
    ManagedSessionRecordSink: class {
      project = components.project;
    },
  }),
);
vi.mock('./hosted-csi-file-history.js', () => ({
  bindHostedCsiHistory: components.bind,
  commitInitialHostedCsiHistory: components.initial,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('original Hosted retirement owner barrier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    components.bind.mockResolvedValue({});
    components.initial.mockResolvedValue(undefined);
    components.project.mockResolvedValue({ messages: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const app = express();
    const contract = createHostedHarnessContract(`sha256:${'a'.repeat(64)}`);
    app.use(bearerAuth('operator'));
    app.use(express.json());
    installHostedHarnessContractMiddleware(app, contract);
    const enteredRetirement = vi.fn();
    app.use((req, _res, next) => {
      if (req.path.endsWith('/internal-csi/retire')) enteredRetirement();
      next();
    });
    const handle = registerHostedCsiSessionRoutes(
      app,
      contract,
      'http://127.0.0.1:8081/internal/managed-session-store/v1',
      { baseUrl: 'http://127.0.0.1:8080', token: 'broker' },
      () => false,
    );
    const headers = {
      Authorization: 'Bearer operator',
      'X-Qwen-Harness-Protocol-Version': '1',
      'X-Qwen-Harness-Boot-Id': contract.bootId,
    };
    const owners = new Map<string, ReturnType<typeof owner>>();
    function owner() {
      const id = randomUUID();
      const bindingId = randomUUID();
      const retirementId = randomUUID();
      const activation = {
        activationId: randomUUID(),
        workerId: contract.bootId,
        phase: 'active',
        epoch: 1,
        expiresAt: Date.now() + 60_000,
      };
      let installed = false;
      const authority = {
        get currentActivation() {
          return installed ? activation : undefined;
        },
        installActivation: vi.fn().mockImplementation(async () => {
          installed = true;
          return activation;
        }),
        renewActivation: vi.fn().mockResolvedValue(activation),
        prepareOriginalCsiRelease: vi
          .fn()
          .mockResolvedValue(['event', 'marker']),
      };
      const status = {
        format: 'qwen-csi-application-retirement/1',
        retirementId,
        stage: 'DRAINED',
        progressVersion: 4,
        frozenRequestSha256: 'a'.repeat(64),
        cutSha256: 'b'.repeat(64),
        finalizeReceiptSha256: 'c'.repeat(64),
      };
      const stores = {
        journalStore: { open: vi.fn().mockResolvedValue({}) },
        resourceStore: { publish: vi.fn().mockResolvedValue({}) },
        publication: {
          owner: vi.fn().mockResolvedValue({ writerGeneration: 1 }),
        },
        assertWritable: vi.fn().mockResolvedValue(undefined),
        stopLocal: vi.fn().mockResolvedValue(undefined),
        csiRetirement: {
          joinWriter: vi.fn().mockResolvedValue(undefined),
          prepare: vi.fn().mockResolvedValue({}),
          complete: vi.fn().mockResolvedValue(status),
        },
      };
      return {
        id,
        bindingId,
        retirementId,
        activation,
        authority,
        stores,
        status,
        body: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          bindingId,
          retirementId,
        },
        attachment: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          writerToken: 'a'.repeat(32),
        },
      };
    }
    components.stores.mockImplementation(
      (options: { sessionKey: { sessionId: string } }) =>
        owners.get(options.sessionKey.sessionId)!.stores,
    );
    components.open.mockImplementation(
      (options: { sessionKey: { sessionId: string } }) =>
        Promise.resolve(owners.get(options.sessionKey.sessionId)!.authority),
    );
    const rpc = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init!.body)) as {
          harnessSessionId: string;
        };
        const selected = owners.get(request.harnessSessionId)!;
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            acquired: true,
            harnessSessionId: selected.id,
            runtimeSessionId: selected.id,
            scope: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              canonicalCwd: '/workspace',
              workspaceGeneration: '1',
              isolationClass: 'session',
              capabilityDigest: CSI_FILES_RETIREMENT_CAPABILITY_DIGEST,
            },
            runtime: { bindingId: selected.bindingId, generation: '1' },
          }),
        );
      });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const post = (
      selected: ReturnType<typeof owner>,
      action: string,
      body: Record<string, unknown>,
    ) =>
      supertest(app)
        .post(`/session/${selected.id}/internal-csi/${action}`)
        .set(headers)
        .send(body);
    const history = (selected: ReturnType<typeof owner>) =>
      supertest(app)
        .get(`/session/${selected.id}/internal-csi/history`)
        .set(headers);
    async function attach() {
      const selected = owner();
      owners.set(selected.id, selected);
      expect((await post(selected, 'attach', selected.attachment)).status).toBe(
        200,
      );
      return selected;
    }
    return {
      app,
      handle,
      headers,
      attach,
      post,
      history,
      rpc,
      interval,
      enteredRetirement,
    };
  }

  it('closes new selected-owner admission before joining and isolates other owners', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      const other = await fixture.attach();
      const joined = deferred<void>();
      const started = deferred<void>();
      selected.stores.csiRetirement.joinWriter.mockImplementation(() => {
        started.resolve();
        return joined.promise;
      });
      const retirement = fixture
        .post(selected, 'retire', selected.body)
        .then((value) => value);
      await started.promise;
      for (const action of ['attach', 'text']) {
        const response = await fixture.post(
          selected,
          action,
          action === 'attach'
            ? selected.attachment
            : { promptId: randomUUID(), text: 'late' },
        );
        expect(response.body.code).toBe('csi_retirement_admission_closed');
      }
      expect((await fixture.history(selected)).body.code).toBe(
        'csi_retirement_admission_closed',
      );
      expect((await fixture.history(other)).status).toBe(200);
      expect(
        selected.authority.prepareOriginalCsiRelease,
      ).not.toHaveBeenCalled();
      expect(selected.stores.stopLocal).not.toHaveBeenCalled();
      joined.resolve();
      expect((await retirement).body).toEqual(selected.status);
      expect(selected.stores.csiRetirement.prepare).toHaveBeenCalledWith([
        'event',
        'marker',
      ]);
      expect(selected.stores.stopLocal).toHaveBeenCalledTimes(1);
      expect(other.stores.csiRetirement.joinWriter).not.toHaveBeenCalled();
      expect(other.stores.stopLocal).not.toHaveBeenCalled();
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('joins an admitted history request and shares the same retirement without self-joining', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      const pendingHistory = deferred<{ messages: never[] }>();
      const started = deferred<void>();
      components.project.mockImplementationOnce(() => {
        started.resolve();
        return pendingHistory.promise;
      });
      const history = fixture.history(selected).then((value) => value);
      await started.promise;
      const entered = deferred<void>();
      fixture.enteredRetirement.mockImplementationOnce(() => entered.resolve());
      const first = fixture
        .post(selected, 'retire', selected.body)
        .then((value) => value);
      await entered.promise;
      expect(
        (
          await fixture.post(selected, 'retire', {
            ...selected.body,
            retirementId: randomUUID(),
          })
        ).body.code,
      ).toBe('csi_retirement_conflict');
      const second = fixture
        .post(selected, 'retire', selected.body)
        .then((value) => value);
      expect(selected.stores.csiRetirement.joinWriter).not.toHaveBeenCalled();
      pendingHistory.resolve({ messages: [] });
      expect((await history).status).toBe(200);
      expect((await first).body).toEqual(selected.status);
      expect((await second).body).toEqual(selected.status);
      expect(selected.stores.csiRetirement.complete).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('preserves a rejected task even after it has left the pending set', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      components.project.mockRejectedValueOnce(undefined);
      expect((await fixture.history(selected)).status).toBe(503);
      const response = await fixture.post(selected, 'retire', selected.body);
      expect(response.body.code).toBe('csi_retirement_task_failed');
      expect(selected.stores.csiRetirement.joinWriter).not.toHaveBeenCalled();
      expect(selected.stores.csiRetirement.complete).not.toHaveBeenCalled();
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('checks the raw in-flight activation outcome before its mapped promise', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      const renewal = deferred<undefined>();
      selected.authority.renewActivation.mockImplementationOnce(
        () => renewal.promise,
      );
      const callback = fixture.interval.mock.calls[0]![0] as () => void;
      callback();
      const entered = deferred<void>();
      fixture.enteredRetirement.mockImplementationOnce(() => entered.resolve());
      const retirement = fixture
        .post(selected, 'retire', selected.body)
        .then((value) => value);
      await entered.promise;
      expect((await fixture.history(selected)).body.code).toBe(
        'csi_retirement_admission_closed',
      );
      renewal.resolve(undefined);
      expect((await retirement).body.code).toBe(
        'csi_retirement_renewal_unresolved',
      );
      expect(selected.stores.csiRetirement.joinWriter).not.toHaveBeenCalled();
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('retries a lost completion with the original preparation and no live acquisition', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      selected.stores.csiRetirement.complete.mockRejectedValueOnce(
        new Error('response lost'),
      );
      expect(
        (await fixture.post(selected, 'retire', selected.body)).status,
      ).toBe(503);
      const acquireCount = fixture.rpc.mock.calls.length;
      expect(selected.stores.stopLocal).not.toHaveBeenCalled();
      expect(
        (await fixture.post(selected, 'retire', selected.body)).body,
      ).toEqual(selected.status);
      expect(
        selected.authority.prepareOriginalCsiRelease,
      ).toHaveBeenCalledTimes(1);
      expect(selected.stores.csiRetirement.joinWriter).toHaveBeenCalledTimes(1);
      expect(selected.stores.csiRetirement.prepare).toHaveBeenCalledTimes(1);
      expect(selected.stores.csiRetirement.complete).toHaveBeenCalledTimes(2);
      expect(fixture.rpc).toHaveBeenCalledTimes(acquireCount);
      expect(selected.stores.stopLocal).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('rejects foreign retirement scope without latching the selected owner', async () => {
    const fixture = setup();
    try {
      const selected = await fixture.attach();
      for (const changed of [
        { tenantId: 'foreign' },
        { workspaceId: 'foreign' },
        { bindingId: randomUUID() },
        { retirementId: 'invalid' },
        { extra: true },
      ]) {
        expect(
          (
            await fixture.post(selected, 'retire', {
              ...selected.body,
              ...changed,
            })
          ).status,
        ).toBe(400);
      }
      expect((await fixture.history(selected)).status).toBe(200);
      expect(selected.stores.csiRetirement.joinWriter).not.toHaveBeenCalled();
    } finally {
      await fixture.handle.stopLocal();
    }
  });

  it('joins an in-flight retirement before disposing stores during Hosted shutdown', async () => {
    const fixture = setup();
    const selected = await fixture.attach();
    const completion = deferred<typeof selected.status>();
    const started = deferred<void>();
    selected.stores.csiRetirement.complete.mockImplementationOnce(() => {
      started.resolve();
      return completion.promise;
    });
    const retirement = fixture
      .post(selected, 'retire', selected.body)
      .then((value) => value);
    await started.promise;
    const stopped = vi.fn();
    const shutdown = fixture.handle.stopLocal().then(stopped);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).not.toHaveBeenCalled();
    expect(selected.stores.stopLocal).not.toHaveBeenCalled();
    completion.resolve(selected.status);
    expect((await retirement).body).toEqual(selected.status);
    await shutdown;
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(selected.stores.stopLocal).toHaveBeenCalled();
  });
});
