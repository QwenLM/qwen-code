/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ManagedToolFileHistoryState } from '@qwen-code/qwen-code-core';
import type { ManagedWorkerBoot } from './managed-runtime-activator.js';
import type { ManagedWorkerFileBoot } from './managed-runtime-worker-bootstrap.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  LocalManagedRuntimeProvider,
  RemoteManagedRuntimeProvider,
} from './managed-runtime-provider.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_ROUTE_PREFIX,
  parseManagedRuntimeExecuteRequest,
  parseManagedRuntimePrepareRequest,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';
import { registerManagedRuntimeWorkerRoutes } from './routes/managed-runtime-worker.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const workspaceCwd = '/tmp/managed-runtime-p8';
const workspaceId = 'workspace-p8';
const token = 'runtime-secret';

const prepareRequest: ManagedRuntimePrepareRequest = {
  protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
  tenantId: 'tenant-p8',
  workspaceId,
  workspaceCwd,
  sessionId: '550e8400-e29b-41d4-a716-446655440108',
  turnKind: 'bootstrap',
};

const tools = [{ name: 'read_file', description: 'Read one file' }];
const manifest = {
  capabilityDigest: createHash('sha256')
    .update(JSON.stringify(tools))
    .digest('hex'),
  tools,
};

function fakeRuntime(): {
  bridge: AcpSessionBridge;
  registry: WorkspaceRegistry;
  execute: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (_sessionId, toolRequest) => ({
    responseParts: [
      {
        functionResponse: {
          id: toolRequest.toolCallId,
          name: toolRequest.toolName,
          response: { output: 'remote workspace evidence' },
        },
      },
    ],
    executionStatus: 'success' as const,
  }));
  const cancel = vi.fn(async () => ({ cancelled: true }));
  const close = vi.fn(async () => undefined);
  const bridge = {
    spawnOrAttach: vi.fn(async (input) => ({
      sessionId: input.sessionId!,
      workspaceCwd,
      attached: false,
      clientId: 'runtime-client-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: input.sessionId!,
    })),
    resumeSession: vi.fn(),
    getSessionSummary: vi.fn(() => {
      throw Object.assign(new Error('not live'), { code: 'session_not_found' });
    }),
    recordHeartbeat: vi.fn(),
    getManagedRuntimeToolManifest: vi.fn(async () => manifest),
    executeManagedRuntimeTool: execute,
    cancelManagedRuntimeTool: cancel,
    closeSession: close,
    detachClient: vi.fn(async () => undefined),
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceId,
    workspaceCwd,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const registry = {
    getByWorkspaceId: vi.fn((id: string) =>
      id === workspaceId ? runtime : undefined,
    ),
  } as unknown as WorkspaceRegistry;
  return { bridge, registry, execute, cancel, close };
}

function workerApp(
  provider: LocalManagedRuntimeProvider,
  owned?: ManagedWorkerBoot | ManagedWorkerFileBoot,
  beforeRoutes?: RequestHandler,
) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  if (beforeRoutes) app.use(beforeRoutes);
  registerManagedRuntimeWorkerRoutes(app, {
    provider,
    owned,
    authorize: (req, res, next) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    },
  });
  return app;
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Managed Runtime providers', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  function toolV2Client() {
    const historyState: ManagedToolFileHistoryState = {
      ownerSessionId: prepareRequest.sessionId,
      revision: 0,
      snapshots: [],
    };
    return {
      fileHistory: {
        bind: vi.fn(async () => historyState),
        checkpoint: vi.fn(async () => historyState),
        snapshot: vi.fn(async () => historyState),
      },
      manifest: vi.fn(async () => manifest),
      beginTurn: vi.fn(async () => {}),
      prepare: vi.fn(async () => ({})),
      confirmation: vi.fn(async () => ({})),
      confirm: vi.fn(async () => {}),
      preflight: vi.fn(async () => ({})),
      execute: vi.fn(async () => ({ executionStatus: 'success' })),
      status: vi.fn(async () => ({ state: 'executing' })),
      cancel: vi.fn(async () => ({ state: 'cancel_requested' })),
    };
  }

  function ownedBoot(): ManagedWorkerBoot {
    return {
      type: 'boot',
      version: 1,
      gatewayIncarnation: 'gateway',
      leaseId: 'lease',
      epoch: 1,
      ...prepareRequest,
      token,
      outputRoot: '/tmp/owned-output',
      cliEntry: '/cli.js',
    };
  }

  function fileOwnedBoot(): ManagedWorkerFileBoot {
    return {
      ...ownedBoot(),
      runtimeInstanceId: 'runtime-instance',
      provisionRequestId: 'provision-request',
      workspaceGeneration: 'workspace-generation',
      capabilityDigest: 'capability-digest',
      isolationClass: 'workspace',
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('attests the exact durable worker identity before private use', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const owned = fileOwnedBoot();
    const app = workerApp(local, owned);
    const body = {
      protocolVersion: 2,
      provisionRequestId: owned.provisionRequestId,
      tenantId: owned.tenantId,
      workspaceId: owned.workspaceId,
      workspaceGeneration: owned.workspaceGeneration,
      workspaceCwd: owned.workspaceCwd,
      capabilityDigest: owned.capabilityDigest,
      isolationClass: owned.isolationClass,
    };
    const attest = (value: Record<string, unknown>) =>
      request(app)
        .post('/internal/managed-runtime/v2/attest')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Qwen-Managed-Lease-Id', owned.leaseId)
        .set('X-Qwen-Managed-Lease-Epoch', String(owned.epoch))
        .send(value);

    await request(app)
      .post('/internal/managed-runtime/v2/attest')
      .send(body)
      .expect(401);
    await attest({ ...body, provisionRequestId: 'another' }).expect(409);
    const response = await attest(body).expect(200);
    expect(response.body).toEqual({
      protocolVersion: 2,
      runtimeInstanceId: owned.runtimeInstanceId,
      runtimeIncarnation: owned.gatewayIncarnation,
      leaseId: owned.leaseId,
      epoch: owned.epoch,
      provisionRequestId: owned.provisionRequestId,
      tenantId: owned.tenantId,
      workspaceId: owned.workspaceId,
      workspaceGeneration: owned.workspaceGeneration,
      workspaceCwd: owned.workspaceCwd,
      capabilityDigest: owned.capabilityDigest,
      isolationClass: owned.isolationClass,
    });
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('fences a parsed first v2 request that arrives after release is acknowledged', async () => {
    const runtime = fakeRuntime();
    runtime.bridge.getManagedToolV2Client = vi.fn(
      () => toolV2Client() as unknown as ManagedToolV2Client,
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const entered = deferred<void>();
    const dispatch = deferred<void>();
    const owned = ownedBoot();
    const server = createServer(
      workerApp(local, owned, (req, _res, next) => {
        if (req.path.endsWith('/v2/manifest')) {
          entered.resolve();
          void dispatch.promise.then(() => next());
        } else next();
      }),
    );
    servers.push(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${await listen(server)}`,
      token,
      lease: owned,
    });
    try {
      const client = await remote.getToolV2Client(prepareRequest);
      const manifest = client.manifest().catch((error: unknown) => error);
      await entered.promise;
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).resolves.toBe(true);
      expect(await manifest).toBeInstanceOf(Error);
      expect(runtime.close).toHaveBeenCalledOnce();
      const late = vi.spyOn(local, 'getToolV2Client');
      dispatch.resolve();
      await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());
      await expect(late.mock.results[0].value).rejects.toThrow();
      expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledOnce();
      expect(() => local.prepare(prepareRequest)).toThrow('closing');
      expect(() => remote.prepare(prepareRequest)).toThrow();
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).resolves.toBe(true);
    } finally {
      dispatch.resolve();
      remote.dispose();
      local.dispose();
    }
  });

  it('upgrades a pending local v1 release to a terminal identity before completing cleanup', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await local.prepare(prepareRequest).ready;
    const close = deferred<void>();
    runtime.close.mockReturnValueOnce(close.promise);
    const ordinary = local.release(prepareRequest.sessionId, prepareRequest);
    const terminal = local.release(prepareRequest.sessionId, prepareRequest, {
      terminal: true,
    });
    expect(() => local.prepare(prepareRequest)).toThrow();
    close.resolve();
    expect(await Promise.all([ordinary, terminal])).toEqual([true, true]);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(() => local.prepare(prepareRequest)).toThrow();
    await expect(local.getToolV2Client(prepareRequest)).rejects.toThrow();
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).resolves.toBe(true);
    await expect(
      local.release(
        prepareRequest.sessionId,
        { ...prepareRequest, tenantId: 'other' },
        { terminal: true },
      ),
    ).rejects.toThrow('identity');
    expect(runtime.close).toHaveBeenCalledOnce();
    local.dispose();
  });

  it('retains a failed terminal close for retry and seals before any preparation has arrived', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    vi.mocked(runtime.bridge.resumeSession).mockRejectedValueOnce(
      new Error('restore failed'),
    );
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest, {
        terminal: true,
      }),
    ).rejects.toThrow('restore failed');
    expect(() => local.prepare(prepareRequest)).toThrow();
    vi.mocked(runtime.bridge.resumeSession).mockRejectedValueOnce(
      Object.assign(new Error('not found'), { code: 'session_not_found' }),
    );
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest, {
        terminal: true,
      }),
    ).resolves.toBe(true);
    expect(() => local.prepare(prepareRequest)).toThrow();
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest, {
        terminal: true,
      }),
    ).resolves.toBe(true);
    expect(runtime.bridge.resumeSession).toHaveBeenCalledTimes(2);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('keeps ordinary v1 release reusable for the same Session identity', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await local.prepare(prepareRequest).ready;
    await local.release(prepareRequest.sessionId, prepareRequest);
    await local.prepare(prepareRequest).ready;
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(2);
    await local.release(prepareRequest.sessionId, prepareRequest);
    local.dispose();
  });

  it('waits for a v2 terminal receipt when a pending remote v1 release is upgraded', async () => {
    const ordinaryAck = deferred<Response>();
    const terminalAck = deferred<Response>();
    const versions: number[] = [];
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      lease: ownedBoot(),
      fetch: vi.fn(async (url: RequestInfo | URL) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/prepare'))
          return Response.json({ protocolVersion: 1, ready: true });
        const version = path.includes('/v2/') ? 2 : 1;
        versions.push(version);
        return version === 1 ? ordinaryAck.promise : terminalAck.promise;
      }),
    });
    try {
      await remote.prepare(prepareRequest).ready;
      let closed = false;
      const ordinary = remote
        .release(prepareRequest.sessionId, prepareRequest)
        .then(() => {
          closed = true;
        });
      await vi.waitFor(() => expect(versions).toEqual([1]));
      const terminal = remote.release(
        prepareRequest.sessionId,
        prepareRequest,
        { terminal: true },
      );
      ordinaryAck.resolve(
        Response.json({ protocolVersion: 1, released: true }),
      );
      await vi.waitFor(() => expect(versions).toEqual([1, 2]));
      expect(closed).toBe(false);
      terminalAck.resolve(
        Response.json({ protocolVersion: 2, released: true }),
      );
      await Promise.all([ordinary, terminal]);
      expect(() => remote.prepare(prepareRequest)).toThrow();
    } finally {
      remote.dispose();
    }
  });

  it('rejects a v1 receipt for terminal release and retries the owned v2 endpoint', async () => {
    const versions: string[] = [];
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      lease: ownedBoot(),
      fetch: vi.fn(async (url: RequestInfo | URL) => {
        versions.push(new URL(String(url)).pathname);
        return Response.json({
          protocolVersion: versions.length === 1 ? 1 : 2,
          released: true,
        });
      }),
    });
    try {
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest, {
          terminal: true,
        }),
      ).rejects.toThrow('did not confirm');
      expect(() => remote.prepare(prepareRequest)).toThrow();
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest, {
          terminal: true,
        }),
      ).resolves.toBe(true);
      expect(versions).toEqual([
        '/internal/managed-runtime/v2/release',
        '/internal/managed-runtime/v2/release',
      ]);
    } finally {
      remote.dispose();
    }
  });

  it('requires an owned lease for terminal release before sending any request', async () => {
    const fetch = vi.fn();
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch,
    });
    await expect(
      remote.release(prepareRequest.sessionId, prepareRequest, {
        terminal: true,
      }),
    ).rejects.toThrow('owned Runtime lease');
    expect(fetch).not.toHaveBeenCalled();
    remote.dispose();
  });

  it('exposes terminal release only with owned auth, lease and strict workspace identity', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.bridge.resumeSession).mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'session_not_found' }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const path = '/internal/managed-runtime/v2/release';
    const body = { ...prepareRequest, protocolVersion: 2 };
    await request(workerApp(local)).post(path).send(body).expect(404);
    const app = workerApp(local, ownedBoot());
    await request(app).post(path).send(body).expect(401);
    await request(app)
      .post(path)
      .set('authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
    const authorized = () =>
      request(app)
        .post(path)
        .set('authorization', `Bearer ${token}`)
        .set('X-Qwen-Managed-Lease-Id', 'lease')
        .set('X-Qwen-Managed-Lease-Epoch', '1');
    await authorized()
      .send({ ...body, tenantId: 'other' })
      .expect(409);
    await authorized()
      .send({ ...body, extra: true })
      .expect(400);
    await authorized()
      .send({ ...body, protocolVersion: 1 })
      .expect(400);
    const result = await authorized().send(body).expect(200);
    expect(result.body).toEqual({ protocolVersion: 2, released: true });
    expect(() => local.prepare(prepareRequest)).toThrow();
    local.dispose();
  });

  it('connects v2 invocations and file history through the owned HTTP listener without losing optional fields', async () => {
    const runtime = fakeRuntime();
    const client = toolV2Client();
    runtime.bridge.getManagedToolV2Client = vi.fn(
      () => client as unknown as ManagedToolV2Client,
    );
    vi.mocked(runtime.bridge.getSessionSummary).mockReturnValue({
      workspaceCwd,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
    } as never);
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const owned: ManagedWorkerBoot = {
      type: 'boot',
      version: 1,
      gatewayIncarnation: 'gateway',
      leaseId: 'lease',
      epoch: 1,
      ...prepareRequest,
      token,
      outputRoot: '/tmp/owned-output',
      cliEntry: '/cli.js',
    };
    const server = createServer(workerApp(local, owned));
    servers.push(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${await listen(server)}`,
      token,
      lease: owned,
    });
    try {
      const connected = await remote.getToolV2Client(prepareRequest);
      const trackedFileBackups = Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `${'directory/'.repeat(5)}file-${i}.txt`,
          {
            backupFileName: '0123456789abcdef@v1',
            version: 1,
            backupTime: '2026-09-09T00:00:00.000Z',
          },
        ]),
      );
      const snapshots = Array.from({ length: 100 }, (_, i) => ({
        promptId: `turn-${i}`,
        timestamp: '2026-09-09T00:00:00.000Z',
        trackedFileBackups,
      }));
      expect(Buffer.byteLength(JSON.stringify(snapshots))).toBeGreaterThan(
        1024 * 1024,
      );
      client.fileHistory.bind.mockResolvedValueOnce({
        ownerSessionId: prepareRequest.sessionId,
        revision: 0,
        snapshots,
      });
      const binding = {
        ownerSessionId: prepareRequest.sessionId,
        ownerRuntimeSessionId: prepareRequest.sessionId,
        executionCwd: workspaceCwd,
        snapshots,
      };
      await expect(connected.fileHistory!.bind(binding)).resolves.toEqual({
        ownerSessionId: prepareRequest.sessionId,
        revision: 0,
        snapshots,
      });
      await connected.fileHistory!.checkpoint('parent-turn');
      await connected.fileHistory!.snapshot();
      expect(client.fileHistory.bind).toHaveBeenCalledExactlyOnceWith(binding);
      expect(client.fileHistory.checkpoint).toHaveBeenCalledExactlyOnceWith(
        'parent-turn',
      );
      expect(client.fileHistory.snapshot).toHaveBeenCalledExactlyOnceWith();
      client.fileHistory.snapshot.mockResolvedValueOnce({
        ownerSessionId: prepareRequest.sessionId,
        revision: -1,
        snapshots: [],
      });
      await expect(connected.fileHistory!.snapshot()).rejects.toThrow();
      await connected.manifest();
      const identity = {
        sessionId: invocation.sessionId,
        promptId: invocation.promptId,
        callId: invocation.callId,
        capabilityDigest: invocation.capabilityDigest,
        policyRevision: invocation.policyRevision,
      };
      await connected.beginTurn(identity);
      await connected.prepare(identity, 'read_file', {
        file_path: 'proof.txt',
      });
      const mediaContext = { inputModalities: { image: true, pdf: false } };
      await connected.prepare(
        identity,
        'read_file',
        { file_path: 'image.png' },
        undefined,
        mediaContext,
      );
      expect(client.prepare).toHaveBeenLastCalledWith(
        identity,
        'read_file',
        { file_path: 'image.png' },
        undefined,
        mediaContext,
      );
      await connected.confirmation(invocation);
      await connected.confirm(invocation, 'proceed_once' as never);
      await connected.confirm(
        invocation,
        'proceed_once' as never,
        { answers: { answer: 'yes' } },
        'preflight',
      );
      await connected.preflight(invocation);
      await connected.execute(invocation);
      await connected.status(invocation);
      await connected.cancel(invocation);
      expect(client.confirm.mock.calls).toEqual([
        [invocation, 'proceed_once', undefined, 'permission'],
        [
          invocation,
          'proceed_once',
          { answers: { answer: 'yes' } },
          'preflight',
        ],
      ]);
      expect(client.execute).toHaveBeenCalledExactlyOnceWith(invocation);
      expect(client.status).toHaveBeenCalledExactlyOnceWith(invocation, 0);
      const data = Buffer.alloc(7 * 1024 * 1024, 1).toString('base64');
      const mediaResult = {
        executionStatus: 'success',
        result: {
          llmContent: [{ inlineData: { mimeType: 'image/jpeg', data } }],
          returnDisplay: 'image',
        },
      };
      const mediaStatus = {
        state: 'settled',
        result: mediaResult,
        progress: [],
        cancelRequested: false,
        firstAvailableSeq: 1,
        lastSeq: 0,
        progressGap: false,
      };
      client.execute.mockResolvedValueOnce(mediaResult);
      client.status.mockResolvedValueOnce(mediaStatus);
      client.cancel.mockResolvedValueOnce(mediaStatus);
      expect(data.length).toBeGreaterThan(8 * 1024 * 1024);
      await expect(connected.execute(invocation)).resolves.toEqual(mediaResult);
      await expect(connected.status(invocation)).resolves.toEqual(mediaStatus);
      await expect(connected.cancel(invocation)).resolves.toEqual(mediaStatus);
      await expect(
        remote.getToolV2Client({ ...prepareRequest, tenantId: 'other' }),
      ).rejects.toThrow();
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).resolves.toBe(true);
      vi.mocked(runtime.bridge.resumeSession).mockRejectedValueOnce(
        Object.assign(new Error('not found'), { code: 'session_not_found' }),
      );
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).resolves.toBe(true);
    } finally {
      remote.dispose();
      local.dispose();
    }
  });

  it('applies the media exception only to valid v2 inline bytes over a chunked HTTP response', async () => {
    let responseText = '';
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/v1/prepare')) {
        res.end(JSON.stringify({ protocolVersion: 1, ready: true }));
        return;
      }
      for (let start = 0; start < responseText.length; start += 256 * 1024) {
        res.write(responseText.slice(start, start + 256 * 1024));
      }
      res.end();
    });
    servers.push(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${await listen(server)}`,
      token,
      lease: ownedBoot(),
    });
    try {
      const connected = await remote.getToolV2Client(prepareRequest);
      const data = 'AAAA'.repeat(2300 * 1024);
      const media = {
        executionStatus: 'success',
        result: {
          llmContent: [{ inlineData: { mimeType: 'image/jpeg', data } }],
          returnDisplay: 'image',
        },
      };
      const valid = JSON.stringify({ protocolVersion: 2, result: media });
      responseText = valid;
      await expect(connected.execute(invocation)).resolves.toEqual(media);
      for (const makeResponse of [
        () =>
          JSON.stringify({
            protocolVersion: 2,
            result: {
              executionStatus: 'success',
              result: { llmContent: data },
            },
          }),
        () =>
          JSON.stringify({
            protocolVersion: 2,
            result: { ...media, postHook: { text: data } },
          }),
        () =>
          `{"result":${JSON.stringify(media)},"protocolVersion":2,"result":{"executionStatus":"success"}}`,
        () => valid + ' '.repeat(8 * 1024 * 1024),
        () => valid.replace(data, '\\u0041'.repeat(data.length)),
      ]) {
        responseText = makeResponse();
        await expect(connected.execute(invocation)).rejects.toThrow(
          'control response exceeded',
        );
      }
      responseText = JSON.stringify({
        protocolVersion: 2,
        result: {
          ...media,
          result: {
            llmContent: [
              { inlineData: { mimeType: 'image/jpeg', data: 'AR==' } },
            ],
          },
        },
      });
      await expect(connected.execute(invocation)).rejects.toThrow(
        'invalid inline media',
      );
      responseText = JSON.stringify({
        protocolVersion: 2,
        result: { state: 'executing', result: media },
      });
      await expect(connected.status(invocation)).rejects.toThrow(
        'control response exceeded',
      );
      responseText = JSON.stringify({
        protocolVersion: 2,
        result: { source: data },
      });
      await expect(connected.fileHistory!.snapshot()).rejects.toThrow(
        'size limit',
      );
      responseText = JSON.stringify({ protocolVersion: 1, result: media });
      await expect(
        remote
          .prepare(prepareRequest)
          .execute({} as never, new AbortController().signal),
      ).rejects.toThrow('size limit');
      responseText = valid + ' '.repeat(64 * 1024 * 1024);
      await expect(connected.execute(invocation)).rejects.toThrow('size limit');
    } finally {
      remote.dispose();
    }
  });

  it('keeps an admitted v2 execute response during release while refusing new execution', async () => {
    const runtime = fakeRuntime();
    const client = toolV2Client();
    const started = deferred<void>();
    const closing = deferred<void>();
    const finish = deferred<void>();
    client.execute.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return { executionStatus: 'success' };
    });
    runtime.close.mockImplementation(async () => {
      closing.resolve();
      await finish.promise;
    });
    runtime.bridge.getManagedToolV2Client = vi.fn(
      () => client as unknown as ManagedToolV2Client,
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const server = createServer(workerApp(local, ownedBoot()));
    servers.push(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${await listen(server)}`,
      token,
      lease: ownedBoot(),
    });
    let pending: Promise<unknown> | undefined;
    let release: Promise<boolean> | undefined;
    try {
      const connected = await remote.getToolV2Client(prepareRequest);
      let settled = false;
      pending = connected.execute(invocation).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      release = remote.release(prepareRequest.sessionId, prepareRequest);
      await closing.promise;
      await expect(connected.execute(invocation)).rejects.toThrow('released');
      await expect(
        connected.prepare(invocation, 'read_file', {}),
      ).rejects.toThrow('released');
      await expect(connected.status(invocation)).resolves.toMatchObject({
        state: 'executing',
      });
      await expect(connected.cancel(invocation)).resolves.toMatchObject({
        state: 'cancel_requested',
      });
      expect(settled).toBe(false);
      finish.resolve();
      await expect(pending).resolves.toEqual({ executionStatus: 'success' });
      await expect(release).resolves.toBe(true);
      expect(client.execute).toHaveBeenCalledOnce();
      await expect(connected.execute(invocation)).rejects.toThrow();
    } finally {
      finish.resolve();
      await Promise.allSettled([pending, release]);
      remote.dispose();
      local.dispose();
    }
  });

  it('pins request identity and lease while retrying cold-start preparation', async () => {
    const lease = { leaseId: 'owned-lease', epoch: 1 };
    const input = { ...prepareRequest };
    let finish!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let requests = 0;
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => {
        if (++requests === 1) return first;
        return Response.json({ protocolVersion: 1, ready: true });
      },
    );
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      lease,
      fetch: fetchImpl,
      prepareRetryDelayMs: 0,
    });
    try {
      const pending = remote.getToolV2Client(input);
      input.workspaceCwd = '/other';
      input.tenantId = 'other';
      lease.epoch = 2;
      lease.leaseId = 'other';
      finish(new Response('', { status: 503 }));
      await pending;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, options] of fetchImpl.mock.calls) {
        expect(JSON.parse(String(options?.body))).toEqual(prepareRequest);
        expect(
          new Headers(options?.headers).get('X-Qwen-Managed-Lease-Id'),
        ).toBe('owned-lease');
        expect(
          new Headers(options?.headers).get('X-Qwen-Managed-Lease-Epoch'),
        ).toBe('1');
      }
    } finally {
      remote.dispose();
    }
  });

  it('retains a failed remote release, permits v2 drain queries, and retries cleanup without executing twice', async () => {
    let releases = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/v1/prepare'))
        return Response.json({ protocolVersion: 1, ready: true });
      if (pathname.endsWith('/release')) {
        if (++releases === 1) return new Response('', { status: 500 });
        return Response.json({ protocolVersion: 2, released: true });
      }
      if (pathname.endsWith('/execute'))
        throw new TypeError('lost execute response');
      return Response.json({
        protocolVersion: 2,
        result: {
          state: 'settled',
          cancelRequested: true,
          result: { executionStatus: 'cancelled' },
        },
      });
    });
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      lease: { leaseId: 'lease', epoch: 1 },
      fetch: fetchImpl,
    });
    try {
      const client = await remote.getToolV2Client(prepareRequest);
      await expect(client.execute(invocation)).rejects.toThrow(
        'lost execute response',
      );
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).rejects.toThrow('HTTP 500');
      await expect(
        client.prepare(invocation, 'read_file', {}),
      ).rejects.toThrow();
      await expect(client.status(invocation)).resolves.toMatchObject({
        state: 'settled',
      });
      await expect(client.cancel(invocation)).resolves.toMatchObject({
        state: 'settled',
      });
      await expect(
        remote.release(prepareRequest.sessionId, prepareRequest),
      ).resolves.toBe(true);
      await expect(client.status(invocation)).rejects.toThrow();
      expect(
        fetchImpl.mock.calls.filter(([url]) =>
          new URL(String(url)).pathname.endsWith('/execute'),
        ),
      ).toHaveLength(1);
    } finally {
      remote.dispose();
    }
  });

  it.each([
    { method: 'execute', result: {} },
    { method: 'execute', result: { executionStatus: 'executing' } },
    { method: 'status', result: { state: 'settled' } },
    { method: 'cancel', result: { state: 'settled', result: {} } },
  ] as const)(
    'rejects a $method response without a physical terminal result: $result',
    async ({ method, result }) => {
      const remote = new RemoteManagedRuntimeProvider({
        baseUrl: 'http://127.0.0.1:4181',
        token,
        lease: { leaseId: 'lease', epoch: 1 },
        fetch: vi.fn(async (input: RequestInfo | URL) =>
          Response.json(
            new URL(String(input)).pathname.endsWith('/v1/prepare')
              ? { protocolVersion: 1, ready: true }
              : { protocolVersion: 2, result },
          ),
        ),
      });
      try {
        const client = await remote.getToolV2Client(prepareRequest);
        await expect(client[method](invocation)).rejects.toThrow(
          method === 'execute'
            ? 'did not confirm physical execution'
            : 'invalid invocation status',
        );
      } finally {
        remote.dispose();
      }
    },
  );

  it('waits for in-flight preparation before releasing its remote Session and keeps failed acquire cleanup reachable', async () => {
    let finish!: (value: Response) => void;
    const ready = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname.endsWith('/prepare')
        ? ready
        : Response.json({ protocolVersion: 2, released: true }),
    );
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      lease: { leaseId: 'lease', epoch: 1 },
      fetch: fetchImpl,
    });
    try {
      const acquired = remote.getToolV2Client(prepareRequest);
      const acquireResult = acquired.catch((error: unknown) => error);
      const released = remote.release(prepareRequest.sessionId, prepareRequest);
      await Promise.resolve();
      expect(fetchImpl).toHaveBeenCalledOnce();
      finish(new Response('', { status: 500 }));
      expect(await acquireResult).toBeInstanceOf(Error);
      await expect(released).resolves.toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      remote.dispose();
    }
  });

  const invocation = {
    sessionId: prepareRequest.sessionId,
    promptId: 'prompt-1',
    callId: 'call-1',
    capabilityDigest: 'a'.repeat(64),
    policyRevision: 'revision',
    invocationId: 'invocation',
    argsDigest: 'b'.repeat(64),
  };

  it('revokes issued v2 clients when the provider is disposed or its workspace is replaced', async () => {
    for (const revoke of ['dispose', 'replace'] as const) {
      const runtime = fakeRuntime();
      const downstream = toolV2Client();
      runtime.bridge.getManagedToolV2Client = vi.fn(
        () => downstream as unknown as ManagedToolV2Client,
      );
      const local = new LocalManagedRuntimeProvider(runtime.registry);
      const client = await local.getToolV2Client(prepareRequest);
      if (revoke === 'dispose') local.dispose();
      else
        vi.mocked(runtime.registry.getByWorkspaceId).mockReturnValue({
          ...runtime.registry.getByWorkspaceId(workspaceId)!,
        });
      await expect(client.execute(invocation)).rejects.toThrow();
      await expect(client.status(invocation)).rejects.toThrow();
      expect(downstream.execute).not.toHaveBeenCalled();
      expect(downstream.status).not.toHaveBeenCalled();
      await expect(client.fileHistory!.snapshot()).rejects.toThrow();
      await expect(
        client.fileHistory!.checkpoint('parent-turn'),
      ).rejects.toThrow();
      expect(downstream.fileHistory.snapshot).not.toHaveBeenCalled();
      expect(downstream.fileHistory.checkpoint).not.toHaveBeenCalled();
      local.dispose();
    }
  });

  it('retains a failed release for retry, blocks admission and permits only drain queries', async () => {
    const runtime = fakeRuntime();
    const downstream = toolV2Client();
    runtime.bridge.getManagedToolV2Client = vi.fn(
      () => downstream as unknown as ManagedToolV2Client,
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const client = await local.getToolV2Client(prepareRequest);
    let failClose!: (error: Error) => void;
    runtime.close.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failClose = reject;
        }),
    );
    const release = local.release(prepareRequest.sessionId, prepareRequest);
    const concurrent = local.release(prepareRequest.sessionId, prepareRequest);
    const firstResult = release.catch((error: unknown) => error);
    const secondResult = concurrent.catch((error: unknown) => error);
    expect(() => local.prepare(prepareRequest)).toThrow();
    await expect(client.execute(invocation)).rejects.toThrow();
    const drain = await local.getToolV2Client(prepareRequest);
    await expect(drain.status(invocation)).resolves.toEqual({
      state: 'executing',
    });
    await expect(drain.cancel(invocation)).resolves.toEqual({
      state: 'cancel_requested',
    });
    await expect(drain.manifest()).rejects.toThrow();
    await expect(drain.fileHistory!.snapshot()).resolves.toEqual({
      ownerSessionId: prepareRequest.sessionId,
      revision: 0,
      snapshots: [],
    });
    await expect(drain.fileHistory!.checkpoint('late')).rejects.toThrow();
    await expect(
      drain.fileHistory!.bind({
        ownerSessionId: prepareRequest.sessionId,
        ownerRuntimeSessionId: prepareRequest.sessionId,
        executionCwd: workspaceCwd,
        snapshots: [],
      }),
    ).rejects.toThrow();
    expect(downstream.fileHistory.checkpoint).not.toHaveBeenCalled();
    expect(downstream.fileHistory.bind).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    const failure = new Error('close did not drain');
    failClose(failure);
    expect(await firstResult).toBe(failure);
    expect(await secondResult).toBe(failure);
    expect(() => local.prepare(prepareRequest)).toThrow();
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    await expect(client.status(invocation)).rejects.toThrow();
    local.dispose();
  });

  it('exposes v2 only on an owned listener and forwards strictly bound calls to the issued client', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const execute = vi.fn(async () => ({
      executionStatus: 'success' as const,
      result: { llmContent: 'proof', returnDisplay: 'proof' },
    }));
    const client = {
      manifest: vi.fn(async () => ({
        ...manifest,
        policyRevision: 'generation',
      })),
      execute,
      beginTurn: vi.fn(async () => {}),
      confirm: vi.fn(async () => {}),
    } as unknown as ManagedToolV2Client;
    runtime.bridge.getManagedToolV2Client = vi.fn(() => client);
    const outer = { ...prepareRequest, protocolVersion: 2 };
    await request(workerApp(local))
      .post('/internal/managed-runtime/v2/manifest')
      .set('Authorization', `Bearer ${token}`)
      .send(outer)
      .expect(404);
    const app = express();
    app.use(express.json());
    registerManagedRuntimeWorkerRoutes(app, {
      provider: local,
      owned: {
        type: 'boot',
        version: 1,
        gatewayIncarnation: 'gateway',
        leaseId: 'lease',
        epoch: 2,
        ...prepareRequest,
        token,
        outputRoot: '/tmp/owned',
        cliEntry: '/tmp/cli.js',
      },
      authorize: (req, res, next) => {
        if (req.headers.authorization !== `Bearer ${token}`)
          res.sendStatus(401);
        else next();
      },
    });
    const post = (operation: string, fields: Record<string, unknown> = {}) =>
      request(app)
        .post(`/internal/managed-runtime/v2/${operation}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Qwen-Managed-Lease-Id', 'lease')
        .set('X-Qwen-Managed-Lease-Epoch', '2')
        .send({ ...outer, ...fields });
    for (const operation of [
      'manifest',
      'begin-turn',
      'prepare',
      'confirmation',
      'confirm',
      'preflight',
      'execute',
      'status',
      'cancel',
    ]) {
      await request(app)
        .post(`/internal/managed-runtime/v2/${operation}`)
        .send(outer)
        .expect(401);
      await request(app)
        .post(`/internal/managed-runtime/v2/${operation}`)
        .set('Authorization', `Bearer ${token}`)
        .send(outer)
        .expect(409);
      await post(operation, { tenantId: 'foreign' }).expect(409);
    }
    expect(runtime.bridge.getManagedToolV2Client).not.toHaveBeenCalled();
    await post('manifest').expect(200);
    expect(runtime.bridge.getManagedToolV2Client).toHaveBeenCalledWith(
      prepareRequest.sessionId,
      { clientId: 'runtime-client-p8' },
    );
    const identity = {
      sessionId: prepareRequest.sessionId,
      promptId: 'prompt-1',
      callId: 'call-1',
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: 'generation',
    };
    const reference = {
      ...identity,
      invocationId: 'invocation-1',
      argsDigest: 'b'.repeat(64),
    };
    await post('execute', { protocolVersion: 1, reference }).expect(400);
    await post('execute', { reference, authorized: true }).expect(400);
    await post('execute', {
      reference: {
        ...reference,
        sessionId: '550e8400-e29b-41d4-a716-446655440109',
      },
    }).expect(400);
    expect(execute).not.toHaveBeenCalled();
    const beginning = await post('begin-turn', { identity }).expect(200);
    expect(beginning.body).toEqual({ protocolVersion: 2, result: null });
    const result = await post('execute', { reference }).expect(200);
    expect(result.body).toMatchObject({
      protocolVersion: 2,
      result: { executionStatus: 'success' },
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(reference);
    expect(runtime.execute).not.toHaveBeenCalled();
    local.dispose();
  });

  it('requires the immutable owned lease and scope on all private operations', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const app = express();
    app.use(express.json());
    const owned = {
      type: 'boot' as const,
      version: 1 as const,
      gatewayIncarnation: 'gateway',
      leaseId: 'lease',
      epoch: 2,
      ...prepareRequest,
      token,
      outputRoot: '/tmp/owned',
      cliEntry: '/tmp/cli.js',
    };
    registerManagedRuntimeWorkerRoutes(app, {
      provider: local,
      owned,
      authorize: (req, res, next) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.sendStatus(401);
          return;
        }
        next();
      },
    });
    for (const operation of [
      'prepare',
      'manifest',
      'execute',
      'cancel',
      'release',
    ]) {
      const url = `${MANAGED_RUNTIME_ROUTE_PREFIX}/${operation}`;
      await request(app).post(url).send(prepareRequest).expect(401);
      await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(prepareRequest)
        .expect(409);
      await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Qwen-Managed-Lease-Id', 'old')
        .set('X-Qwen-Managed-Lease-Epoch', '2')
        .send(prepareRequest)
        .expect(409);
      await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Qwen-Managed-Lease-Id', 'lease')
        .set('X-Qwen-Managed-Lease-Epoch', '2')
        .send({ ...prepareRequest, tenantId: 'other' })
        .expect(409);
    }
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    const server = createServer(app);
    servers.push(server);
    const port = await listen(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      lease: owned,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledOnce();
    await expect(
      handle.getManifest(new AbortController().signal),
    ).resolves.toEqual(manifest);
    remote.dispose();
    local.dispose();
  });

  it('keeps Gateway prepare pending until a separate Runtime worker starts', async () => {
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);

    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      prepareRetryDelayMs: 5,
      prepareRetryMaxDelayMs: 10,
      prepareRetryWindowMs: 2_000,
    });
    const handle = remote.prepare(prepareRequest);
    let ready = false;
    void handle.ready.then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).toBe(false);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();

    const server = createServer(workerApp(local));
    servers.push(server);
    await listen(server, port);
    await handle.ready;
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).resolves.toEqual(manifest);
    await expect(
      handle.execute(
        {
          executionId: 'execution-p8',
          turnId: 'turn-p8',
          toolCallId: 'call-p8',
          capabilityDigest: manifest.capabilityDigest,
          toolName: 'read_file',
          input: { file_path: 'proof.txt' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ executionStatus: 'success' });
    expect(runtime.execute).toHaveBeenCalledTimes(1);

    await close(server);
    local.dispose();
    vi.mocked(runtime.bridge.resumeSession).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-restored-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });
    const restoredLocal = new LocalManagedRuntimeProvider(runtime.registry);
    const restoredServer = createServer(workerApp(restoredLocal));
    servers.push(restoredServer);
    await listen(restoredServer, port);
    const continuation = remote.prepare({
      ...prepareRequest,
      turnKind: 'continuation',
    });
    await continuation.ready;
    await expect(
      continuation.getManifest(new AbortController().signal),
    ).resolves.toEqual(manifest);
    expect(runtime.bridge.resumeSession).toHaveBeenCalledWith({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
    });

    await close(restoredServer);
    restoredLocal.dispose();
    vi.mocked(runtime.bridge.resumeSession).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-release-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });
    const releaseLocal = new LocalManagedRuntimeProvider(runtime.registry);
    const releaseServer = createServer(workerApp(releaseLocal));
    servers.push(releaseServer);
    await listen(releaseServer, port);

    await expect(remote.release(prepareRequest.sessionId)).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledWith(prepareRequest.sessionId, {
      clientId: 'runtime-client-release-p8',
    });
    remote.dispose();
    releaseLocal.dispose();
  });

  it('sends explicit cancellation without retrying Tool execution', async () => {
    const runtime = fakeRuntime();
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    runtime.execute.mockImplementation(
      (_sessionId, _toolRequest, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          executionStarted();
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const server = createServer(workerApp(local));
    servers.push(server);
    const port = await listen(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;
    const controller = new AbortController();
    const execution = handle.execute(
      {
        executionId: 'execution-cancel-p8',
        turnId: 'turn-cancel-p8',
        toolCallId: 'call-cancel-p8',
        capabilityDigest: manifest.capabilityDigest,
        toolName: 'read_file',
        input: { file_path: 'proof.txt' },
      },
      controller.signal,
    );
    await started;
    controller.abort(new Error('deadline'));
    await expect(execution).rejects.toThrow('deadline');
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1));
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    remote.dispose();
    local.dispose();
  });

  it('closes a restored Session when release races with warmup', async () => {
    const runtime = fakeRuntime();
    let finishResume!: (session: {
      sessionId: string;
      workspaceCwd: string;
      attached: true;
      clientId: string;
      hasActivePrompt: false;
      sourceType: 'managed-gateway';
      sourceId: string;
      sourcePersisted: true;
      state: never;
    }) => void;
    vi.mocked(runtime.bridge.resumeSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const continuation = {
      ...prepareRequest,
      turnKind: 'continuation',
    } as const;
    const handle = local.prepare(continuation);
    const ready = handle.ready.catch((error: unknown) => error);
    const release = local.release(prepareRequest.sessionId, continuation);

    finishResume({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-racing-release-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });

    await expect(ready).resolves.toMatchObject({
      message: 'Managed Runtime Session released.',
    });
    await expect(release).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledWith(prepareRequest.sessionId, {
      clientId: 'runtime-client-racing-release-p8',
    });
    local.dispose();
  });

  it('does not close a colliding Session when release races with warmup', async () => {
    const runtime = fakeRuntime();
    let finishResume!: (session: {
      sessionId: string;
      workspaceCwd: string;
      attached: true;
      clientId: string;
      hasActivePrompt: false;
      sourceType: 'foreign-owner';
      sourceId: string;
      sourcePersisted: true;
      state: never;
    }) => void;
    vi.mocked(runtime.bridge.resumeSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const continuation = {
      ...prepareRequest,
      turnKind: 'continuation',
    } as const;
    const handle = local.prepare(continuation);
    const ready = handle.ready.catch((error: unknown) => error);
    const release = local.release(prepareRequest.sessionId, continuation);

    finishResume({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'foreign-client-p8',
      hasActivePrompt: false,
      sourceType: 'foreign-owner',
      sourceId: 'foreign-session-p8',
      sourcePersisted: true,
      state: {} as never,
    });

    await expect(ready).resolves.toMatchObject({
      message: 'Managed Runtime Session released.',
    });
    await expect(release).resolves.toBe(true);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.bridge.detachClient).toHaveBeenCalledWith(
      prepareRequest.sessionId,
      'foreign-client-p8',
    );
    local.dispose();
  });

  it('retains a Session created during warmup until its failed close is retried', async () => {
    const runtime = fakeRuntime();
    let finishSpawn!: (
      session: Awaited<ReturnType<AcpSessionBridge['spawnOrAttach']>>,
    ) => void;
    vi.mocked(runtime.bridge.spawnOrAttach).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSpawn = resolve;
      }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const ready = local
      .prepare(prepareRequest)
      .ready.catch((error: unknown) => error);
    const failure = new Error('close failed after spawn');
    runtime.close.mockRejectedValueOnce(failure);
    const releasing = local
      .release(prepareRequest.sessionId, prepareRequest)
      .catch((error: unknown) => error);
    expect(() => local.prepare(prepareRequest)).toThrow();
    expect(runtime.close).not.toHaveBeenCalled();
    finishSpawn({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: false,
      clientId: 'late-client',
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      hasActivePrompt: false,
      sourcePersisted: true,
    });
    await expect(ready).resolves.toMatchObject({
      message: 'Managed Runtime Session released.',
    });
    expect(await releasing).toBe(failure);
    expect(() => local.prepare(prepareRequest)).toThrow();
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenLastCalledWith(prepareRequest.sessionId, {
      clientId: 'late-client',
    });
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(runtime.bridge.resumeSession).not.toHaveBeenCalled();
    local.dispose();
  });

  it('does not treat a vanished Session after failed close as proof of release', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await local.prepare(prepareRequest).ready;
    runtime.close
      .mockRejectedValueOnce(new Error('transport lost'))
      .mockRejectedValueOnce(
        Object.assign(new Error('not found'), { code: 'session_not_found' }),
      );
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).rejects.toThrow('transport lost');
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).rejects.toThrow('not found');
    expect(() => local.prepare(prepareRequest)).toThrow('closing');
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    local.dispose();
  });

  it('retains a failed cleanup of a colliding warmup attachment for retry', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.bridge.spawnOrAttach).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'foreign-client',
      sourceType: 'managed-gateway',
      sourceId: 'foreign-owner',
    });
    vi.mocked(runtime.bridge.detachClient).mockRejectedValueOnce(
      new Error('detach failed'),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await expect(local.prepare(prepareRequest).ready).rejects.toThrow(
      'cleanup failed',
    );
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).rejects.toThrow('cleanup failed');
    expect(() => local.prepare(prepareRequest)).toThrow('closing');
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).resolves.toBe(true);
    expect(runtime.bridge.detachClient).toHaveBeenCalledTimes(2);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    local.dispose();
  });

  it('retries the same attachment cleanup when restoring an untracked release', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.bridge.resumeSession).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'foreign-restored-client',
      sourceType: 'managed-gateway',
      sourceId: 'foreign-owner',
      state: {},
    });
    vi.mocked(runtime.bridge.detachClient).mockRejectedValueOnce(
      new Error('detach failed'),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).rejects.toThrow('cleanup failed');
    expect(() => local.prepare(prepareRequest)).toThrow('closing');
    await expect(
      local.release(prepareRequest.sessionId, prepareRequest),
    ).resolves.toBe(true);
    expect(runtime.bridge.detachClient).toHaveBeenCalledTimes(2);
    expect(runtime.bridge.detachClient).toHaveBeenLastCalledWith(
      prepareRequest.sessionId,
      'foreign-restored-client',
    );
    expect(runtime.bridge.resumeSession).toHaveBeenCalledTimes(1);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    local.dispose();
  });

  it('rejects unauthenticated and model-bearing worker requests', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const app = workerApp(local);
    await request(app)
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .send(prepareRequest)
      .expect(401);
    const forbidden = await request(app)
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .set('authorization', `Bearer ${token}`)
      .send({ ...prepareRequest, prompt: 'must not cross the boundary' });
    expect(forbidden.status).toBe(400);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('treats a workspace mapping mismatch as a permanent conflict', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const response = await request(workerApp(local))
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .set('authorization', `Bearer ${token}`)
      .send({ ...prepareRequest, workspaceCwd: '/tmp/wrong-workspace' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('rejects cleartext non-loopback Runtime origins', () => {
    expect(
      () =>
        new RemoteManagedRuntimeProvider({
          baseUrl: 'http://10.0.0.10:4181',
          token,
        }),
    ).toThrow('must use HTTPS');
  });

  it('stops reading an oversized Runtime response', async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.close();
          },
        }),
      );
    }) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('exceeded its size limit');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('bounds a prepare request when the Runtime never responds', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const rejectAborted = () => reject(signal.reason);
          if (signal.aborted) rejectAborted();
          else signal.addEventListener('abort', rejectAborted, { once: true });
        }),
    ) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
      prepareRetryWindowMs: 20,
    });

    await expect(remote.prepare(prepareRequest).ready).rejects.toThrow(
      'preparation timed out',
    );
    remote.prepare(prepareRequest);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('invalidates an existing remote handle when its Session is released', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/prepare')) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      }
      if (pathname.endsWith('/release')) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          released: true,
        });
      }
      return Response.json({
        protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
        manifest,
      });
    }) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;
    await expect(remote.release(prepareRequest.sessionId)).resolves.toBe(true);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('Managed Runtime Session released.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('invalidates an existing local handle when its Session is released', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const handle = local.prepare(prepareRequest);
    await handle.ready;
    await expect(local.release(prepareRequest.sessionId)).resolves.toBe(true);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('Managed Runtime Session released.');
    expect(runtime.bridge.getManagedRuntimeToolManifest).not.toHaveBeenCalled();
    local.dispose();
  });
});

describe('Managed Runtime protocol', () => {
  it('accepts only versioned Prompt-free identity payloads', () => {
    expect(parseManagedRuntimePrepareRequest(prepareRequest)).toEqual(
      prepareRequest,
    );
    expect(() =>
      parseManagedRuntimePrepareRequest({
        ...prepareRequest,
        protocolVersion: 2,
      }),
    ).toThrow('unsupported');
    expect(() =>
      parseManagedRuntimePrepareRequest({
        ...prepareRequest,
        history: [],
      }),
    ).toThrow();
    expect(() =>
      parseManagedRuntimeExecuteRequest({
        ...prepareRequest,
        toolRequest: {
          executionId: 'x'.repeat(129),
          turnId: 'turn-p8',
          toolCallId: 'call-p8',
          capabilityDigest: manifest.capabilityDigest,
          toolName: 'read_file',
          input: {},
        },
      }),
    ).toThrow();
  });
});
