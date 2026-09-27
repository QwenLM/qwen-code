/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ManagedToolFileHistoryState } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import {
  RequestedSessionIdRejectedError,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
  LocalManagedRuntimeProvider,
  RemoteManagedRuntimeProvider,
} from './managed-runtime-provider.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  parseManagedRuntimeExecuteRequest,
  parseManagedRuntimePrepareRequest,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('rejects a bridge without managed tool capabilities before spawning', () => {
    const runtime = fakeRuntime();
    delete runtime.bridge.executeManagedRuntimeTool;
    const provider = new LocalManagedRuntimeProvider(runtime.registry);
    expect(() => provider.prepare(prepareRequest)).toThrow('does not support');
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
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
      lease: { leaseId: 'lease', epoch: 1 },
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
      lease: { leaseId: 'lease', epoch: 1 },
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
      lease: { leaseId: 'lease', epoch: 1 },
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

  it('reports a requested ID already live in a paired Bridge as an identity conflict', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.bridge.spawnOrAttach).mockRejectedValueOnce(
      new RequestedSessionIdRejectedError(
        'session_id_conflict',
        prepareRequest.sessionId,
      ),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await expect(local.prepare(prepareRequest).ready).rejects.toMatchObject({
      name: 'ManagedRuntimeProviderError',
      code: 'managed_runtime_identity_conflict',
      retryable: false,
    });
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
    local.dispose();
  });

  it('reports a continuation whose fallback create finds the ID live as an identity conflict', async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.bridge.resumeSession).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'session_not_found' }),
    );
    vi.mocked(runtime.bridge.spawnOrAttach).mockRejectedValueOnce(
      new RequestedSessionIdRejectedError(
        'session_id_conflict',
        prepareRequest.sessionId,
      ),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    await expect(
      local.prepare({ ...prepareRequest, turnKind: 'continuation' }).ready,
    ).rejects.toMatchObject({
      name: 'ManagedRuntimeProviderError',
      code: 'managed_runtime_identity_conflict',
      retryable: false,
    });
    expect(runtime.bridge.resumeSession).toHaveBeenCalledTimes(1);
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
