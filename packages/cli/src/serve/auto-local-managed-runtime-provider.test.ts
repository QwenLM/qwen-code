/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoLocalManagedRuntimeProvider } from './auto-local-managed-runtime-provider.js';
import {
  ManagedRuntimeReleasedError,
  type ManagedRuntimeEndpoint,
} from './managed-runtime-activator.js';
import type { LocalProcessRuntimeActivator } from './local-process-runtime-activator.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const request = {
  protocolVersion: 1 as const,
  tenantId: 'tenant',
  workspaceId: 'workspace',
  workspaceCwd: '/tmp',
  sessionId: '550e8400-e29b-41d4-a716-446655440108',
  turnKind: 'bootstrap' as const,
};
function endpoint(leaseId: string): ManagedRuntimeEndpoint {
  return {
    url: 'http://127.0.0.1:12345',
    deadline: Date.now() + 1000,
    boot: {
      ...request,
      version: 1,
      type: 'boot',
      leaseId,
      epoch: 1,
      gatewayIncarnation: 'gateway',
      token: 'secret',
      cliEntry: '/cli.js',
      outputRoot: '/tmp/owned',
    },
  };
}
function setup() {
  const runtime = {
    workspaceId: request.workspaceId,
    workspaceCwd: request.workspaceCwd,
    trusted: true,
  } as WorkspaceRuntime;
  const registry = {
    getByWorkspaceId: () => runtime,
  } as unknown as WorkspaceRegistry;
  const activate = vi.fn();
  const lost = vi.fn();
  const activator = {
    activate,
    close: vi.fn(async () => {}),
  } as unknown as LocalProcessRuntimeActivator;
  const provider = new AutoLocalManagedRuntimeProvider(
    registry,
    activator,
    lost,
  );
  return { activate, lost, provider };
}
function use(promise = Promise.resolve(endpoint('one'))) {
  const controller = new AbortController();
  const exit = deferred<void>();
  const release = vi.fn();
  const finished = vi.fn();
  return {
    controller,
    exit,
    exited: exit.promise,
    endpoint: promise,
    signal: controller.signal,
    release,
    beginOperation: vi.fn(() => finished),
    finished,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('AutoLocal Managed Runtime provider', () => {
  it('forwards history with the owned identity and only allows snapshots while closing', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const closing = deferred<Response>();
    const state = {
      ownerSessionId: request.sessionId,
      revision: 0,
      snapshots: [],
    };
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        if (url.pathname.endsWith('/v1/prepare'))
          return Response.json({ protocolVersion: 1, ready: true });
        if (url.pathname.endsWith('/release')) return closing.promise;
        return Response.json({ protocolVersion: 2, result: state });
      }),
    );
    const client = await provider.getToolV2Client(request);
    const binding = {
      ownerSessionId: request.sessionId,
      ownerRuntimeSessionId: request.sessionId,
      executionCwd: request.workspaceCwd,
      snapshots: [],
    };
    await expect(client.fileHistory!.bind(binding)).resolves.toEqual(state);
    await client.fileHistory!.checkpoint('parent-turn');
    const release = provider.release(request.sessionId, request);
    await expect(client.fileHistory!.bind(binding)).rejects.toThrow();
    await expect(client.fileHistory!.checkpoint('late')).rejects.toThrow();
    await expect(client.fileHistory!.snapshot()).resolves.toEqual(state);
    expect(calls).toContainEqual({
      path: '/internal/managed-runtime/v2/bind-history',
      body: { ...request, protocolVersion: 2, binding },
    });
    expect(calls.filter(({ path }) => path.endsWith('/checkpoint'))).toEqual([
      {
        path: '/internal/managed-runtime/v2/checkpoint',
        body: { ...request, protocolVersion: 2, promptId: 'parent-turn' },
      },
    ]);
    closing.resolve(Response.json({ protocolVersion: 2, released: true }));
    await expect(release).resolves.toBe(true);
    await expect(client.fileHistory!.snapshot()).rejects.toThrow();
    expect(active.beginOperation).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('retains a failed acquire until release is acknowledged, and rejects an unproved false ACK', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    let releases = 0;
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/prepare'))
        return new Response('', { status: 500 });
      return Response.json({ protocolVersion: 2, released: ++releases > 1 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(provider.getToolV2Client(request)).rejects.toThrow('HTTP 500');
    await expect(provider.release(request.sessionId, request)).rejects.toThrow(
      'did not confirm',
    );
    expect(active.release).not.toHaveBeenCalled();
    await expect(provider.release(request.sessionId, request)).resolves.toBe(
      true,
    );
    expect(active.release).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('preserves a failed worker containment result and cannot reacquire or report release', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ protocolVersion: 1, ready: true })),
    );
    const client = await provider.getToolV2Client(request);
    active.controller.abort(new Error('worker transport failed'));
    const release = provider.release(request.sessionId, request);
    const failed = release.catch((error: unknown) => error);
    active.exit.reject(new Error('containment failed'));
    expect(await failed).toMatchObject({ message: 'containment failed' });
    await expect(provider.release(request.sessionId, request)).rejects.toThrow(
      'containment failed',
    );
    await expect(client.manifest()).rejects.toThrow();
    expect(active.release).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('reuses one v2 binding and keeps its use until remote release succeeds', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const closing = deferred<Response>();
    let releases = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith('/v1/prepare'))
          return Response.json({ protocolVersion: 1, ready: true });
        if (url.pathname.endsWith('/release')) {
          return ++releases === 1
            ? closing.promise
            : Response.json({ protocolVersion: 2, released: true });
        }
        return Response.json({
          protocolVersion: 2,
          result: {
            state: 'settled',
            cancelRequested: true,
            result: { executionStatus: 'cancelled' },
          },
        });
      }),
    );
    const client = await provider.getToolV2Client(request);
    expect(await provider.getToolV2Client(request)).toBe(client);
    expect(activate).toHaveBeenCalledOnce();
    const release = provider.release(request.sessionId, request);
    const failed = release.catch((error: unknown) => error);
    await Promise.resolve();
    expect(active.release).not.toHaveBeenCalled();
    await expect(client.manifest()).rejects.toThrow();
    const reference = { sessionId: request.sessionId } as never;
    await expect(client.status(reference)).resolves.toMatchObject({
      state: 'settled',
    });
    closing.resolve(new Response('', { status: 500 }));
    expect(await failed).toMatchObject({
      message: 'Managed Runtime returned HTTP 500.',
    });
    expect(active.release).not.toHaveBeenCalled();
    await expect(
      provider.getToolV2Client({ ...request, tenantId: 'other' }),
    ).rejects.toThrow();
    await expect(provider.release(request.sessionId, request)).resolves.toBe(
      true,
    );
    expect(active.release).toHaveBeenCalledExactlyOnceWith('cancelled');
    expect(() => provider.prepare(request)).toThrow('permanently closed');
    await expect(provider.getToolV2Client(request)).rejects.toThrow(
      'permanently closed',
    );
    await expect(
      provider.release(request.sessionId, { ...request, tenantId: 'other' }),
    ).rejects.toThrow('identity');
    await expect(provider.release(request.sessionId, request)).resolves.toBe(
      true,
    );
    await provider.dispose();
  });

  it('upgrades a pending ordinary release and waits for the terminal worker receipt before releasing its use', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const ordinaryAck = deferred<Response>();
    const terminalAck = deferred<Response>();
    const versions: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith('/prepare'))
          return Response.json({ protocolVersion: 1, ready: true });
        const version = url.pathname.includes('/v2/') ? 2 : 1;
        versions.push(version);
        return version === 1 ? ordinaryAck.promise : terminalAck.promise;
      }),
    );
    try {
      await provider.prepare(request).ready;
      const ordinary = provider.release(request.sessionId, request);
      await vi.waitFor(() => expect(versions).toEqual([1]));
      const terminal = provider.release(request.sessionId, request, {
        terminal: true,
      });
      ordinaryAck.resolve(
        Response.json({ protocolVersion: 1, released: true }),
      );
      await vi.waitFor(() => expect(versions).toEqual([1, 2]));
      expect(active.release).not.toHaveBeenCalled();
      terminalAck.resolve(
        Response.json({ protocolVersion: 2, released: true }),
      );
      expect(await Promise.all([ordinary, terminal])).toEqual([true, true]);
      expect(active.release).toHaveBeenCalledOnce();
      expect(() => provider.prepare(request)).toThrow('permanently closed');
      await expect(provider.release(request.sessionId, request)).resolves.toBe(
        true,
      );
      expect(activate).toHaveBeenCalledOnce();
    } finally {
      await provider.dispose();
    }
  });

  it('seals a never-acquired terminal identity without starting a worker', async () => {
    const { provider, activate } = setup();
    await expect(
      provider.release(request.sessionId, request, { terminal: true }),
    ).resolves.toBe(true);
    expect(() => provider.prepare(request)).toThrow('permanently closed');
    await expect(provider.getToolV2Client(request)).rejects.toThrow(
      'permanently closed',
    );
    await expect(
      provider.release(
        request.sessionId,
        { ...request, workspaceCwd: '/other' },
        { terminal: true },
      ),
    ).rejects.toThrow('identity');
    expect(activate).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('waits for actual worker exit after transport loss instead of treating abort as drain', async () => {
    const { provider, activate, lost } = setup();
    const active = use();
    activate.mockReturnValue(active);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ protocolVersion: 1, ready: true })),
    );
    const client = await provider.getToolV2Client(request);
    active.controller.abort(new Error('worker died'));
    expect(lost).toHaveBeenCalledOnce();
    let released = false;
    const closing = provider.release(request.sessionId, request).then(() => {
      released = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);
    expect(active.release).not.toHaveBeenCalled();
    await expect(client.manifest()).rejects.toThrow();
    active.exit.resolve();
    await closing;
    expect(active.release).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it('keeps an uncertain v2 execution reserved until status proves its physical result', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/v1/prepare'))
        return Response.json({ protocolVersion: 1, ready: true });
      if (url.pathname.endsWith('/execute'))
        throw new TypeError('lost execute response');
      return Response.json({
        protocolVersion: 2,
        result: {
          state: 'settled',
          cancelRequested: false,
          result: { executionStatus: 'success' },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const client = await provider.getToolV2Client(request);
    const reference = {
      sessionId: request.sessionId,
      invocationId: 'invocation',
    } as never;
    await expect(client.execute(reference)).rejects.toThrow(
      'lost execute response',
    );
    expect(active.finished).toHaveBeenCalledExactlyOnceWith(false);
    await expect(client.status(reference)).resolves.toMatchObject({
      state: 'settled',
    });
    expect(active.finished).toHaveBeenLastCalledWith(true);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname.endsWith('/execute')),
    ).toHaveLength(1);
    await provider.dispose();
  });

  it('returns immediately while the worker is pending and releases only the dispatch use', async () => {
    const { provider, activate } = setup();
    const pending = deferred<ManagedRuntimeEndpoint>();
    const active = use(pending.promise);
    activate.mockReturnValue(active);
    const fetch = vi.fn(async () =>
      Response.json({ protocolVersion: 1, ready: true }),
    );
    vi.stubGlobal('fetch', fetch);
    const handle = provider.prepare(request);
    handle.finish('completed');
    expect(active.release).toHaveBeenCalledWith('completed');
    expect(fetch).not.toHaveBeenCalled();
    pending.resolve(endpoint('one'));
    await handle.ready;
    expect(fetch).toHaveBeenCalledOnce();
    await provider.dispose();
  });
  it('does not attribute an old generation death to a replacement Session binding', async () => {
    const { provider, activate, lost } = setup();
    const first = use();
    const second = use(Promise.resolve(endpoint('two')));
    activate.mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ protocolVersion: 1, ready: true })),
    );
    const oldHandle = provider.prepare(request);
    await oldHandle.ready;
    const newHandle = provider.prepare({
      ...request,
      turnKind: 'continuation',
    });
    await newHandle.ready;
    first.controller.abort(new ManagedRuntimeReleasedError('evicted'));
    expect(lost).not.toHaveBeenCalled();
    second.controller.abort(new Error('worker died'));
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0]?.[1]).toBe(false);
    await expect(
      oldHandle.getManifest(new AbortController().signal),
    ).rejects.toThrow('evicted');
    await provider.dispose();
  });
  it('retires uncertain execution once, never retries it and excludes late results', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const dispatched = deferred<void>();
    const late = deferred<Response>();
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/execute')) {
        dispatched.resolve();
        return late.promise;
      }
      return Response.json({ protocolVersion: 1, ready: true });
    });
    vi.stubGlobal('fetch', fetch);
    const handle = provider.prepare(request);
    await handle.ready;
    const abort = new AbortController();
    const result = handle.execute(
      {
        executionId: 'execution',
        turnId: 'turn',
        toolCallId: 'tool',
        capabilityDigest: 'digest',
        toolName: 'read_file',
        input: {},
      },
      abort.signal,
    );
    await dispatched.promise;
    abort.abort(new Error('cancelled'));
    late.resolve(
      Response.json({
        protocolVersion: 1,
        result: { executionStatus: 'success', responseParts: [] },
      }),
    );
    await expect(result).rejects.toThrow('cancelled');
    expect(active.finished).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname.endsWith('/execute')),
    ).toHaveLength(1);
    handle.finish('cancelled');
    await provider.dispose();
  });
});
