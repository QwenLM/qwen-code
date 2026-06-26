import { describe, expect, it } from 'bun:test';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import {
  registerSessionsHandlers,
  waitForSessionListExternalRefresh,
} from './sessions';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTestHarness(options?: {
  refreshExternalSessions?: (workspaceId?: string) => Promise<void>;
}) {
  const handlers = new Map<string, HandlerFn>();
  const calls: string[] = [];

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    push() {},
    async invokeClient() {
      return undefined;
    },
  };

  const sessionManager = {
    waitForInit: async () => {
      calls.push('waitForInit');
    },
    refreshExternalSessions: async (workspaceId?: string) => {
      calls.push(`refreshExternalSessions:${workspaceId ?? ''}`);
      await options?.refreshExternalSessions?.(workspaceId);
    },
    getSessions: (workspaceId?: string) => {
      calls.push(`getSessions:${workspaceId ?? ''}`);
      return [{ id: 's1', workspaceId, messages: [] }];
    },
  };

  const deps: HandlerDeps = {
    sessionManager: sessionManager as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  };

  registerSessionsHandlers(server, deps);

  const get = handlers.get(RPC_CHANNELS.sessions.GET);
  if (!get) {
    throw new Error('GET handler not registered');
  }

  const getForWorkspace = handlers.get(RPC_CHANNELS.sessions.GET_FOR_WORKSPACE);
  if (!getForWorkspace) {
    throw new Error('GET_FOR_WORKSPACE handler not registered');
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'current-workspace',
    webContentsId: 101,
  };

  return { get, getForWorkspace, ctx, calls };
}

describe('registerSessionsHandlers GET', () => {
  it('refreshes external provider sessions before returning current workspace sessions', async () => {
    const refresh = deferred();
    const { get, ctx, calls } = createTestHarness({
      refreshExternalSessions: () => refresh.promise,
    });

    const resultPromise = get(ctx);
    await Promise.resolve();
    expect(calls).toEqual([
      'waitForInit',
      'refreshExternalSessions:current-workspace',
    ]);

    refresh.resolve();
    const result = await resultPromise;

    expect(result).toEqual([
      { id: 's1', workspaceId: 'current-workspace', messages: [] },
    ]);
    expect(calls).toEqual([
      'waitForInit',
      'refreshExternalSessions:current-workspace',
      'getSessions:current-workspace',
    ]);
  });

  it('does not fail the session list request when external refresh fails', async () => {
    const { get, ctx } = createTestHarness({
      refreshExternalSessions: async () => {
        throw new Error('provider is slow');
      },
    });

    const result = await get(ctx);

    expect(result).toEqual([
      { id: 's1', workspaceId: 'current-workspace', messages: [] },
    ]);
  });
});

describe('waitForSessionListExternalRefresh', () => {
  it('returns after the wait timeout while the refresh keeps running', async () => {
    const refresh = deferred();
    const warnings: unknown[][] = [];

    const result = await Promise.race([
      waitForSessionListExternalRefresh(refresh.promise, {
        log: { warn: (...args: unknown[]) => warnings.push(args) },
        timeoutMs: 1,
        workspaceId: 'current-workspace',
      }).then(() => 'returned'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-waiting'), 50),
      ),
    ]);

    expect(result).toBe('returned');
    expect(warnings.length).toBe(1);
    const [message] = warnings[0] ?? [];
    expect(String(message)).toContain('current-workspace');

    refresh.resolve();
  });

  it('logs refresh failures without failing the session list request', async () => {
    const warnings: unknown[][] = [];

    await waitForSessionListExternalRefresh(
      Promise.reject(new Error('provider failed')),
      {
        log: { warn: (...args: unknown[]) => warnings.push(args) },
        timeoutMs: 50,
        workspaceId: 'current-workspace',
      },
    );

    expect(warnings.length).toBe(1);
    const [message, error] = warnings[0] ?? [];
    expect(String(message)).toContain('failed');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('registerSessionsHandlers GET_FOR_WORKSPACE', () => {
  it('refreshes external provider sessions before returning workspace sessions', async () => {
    const { getForWorkspace, ctx, calls } = createTestHarness();

    const result = await getForWorkspace(ctx, 'target-workspace');

    expect(calls).toEqual([
      'waitForInit',
      'refreshExternalSessions:target-workspace',
      'getSessions:target-workspace',
    ]);
    expect(result).toEqual([
      { id: 's1', workspaceId: 'target-workspace', messages: [] },
    ]);
  });

  it('can return cached workspace sessions without waiting for external refresh', async () => {
    const { getForWorkspace, ctx, calls } = createTestHarness();

    const result = await getForWorkspace(ctx, 'target-workspace', {
      refreshExternal: false,
    });

    expect(calls).toEqual(['waitForInit', 'getSessions:target-workspace']);
    expect(result).toEqual([
      { id: 's1', workspaceId: 'target-workspace', messages: [] },
    ]);
  });
});
