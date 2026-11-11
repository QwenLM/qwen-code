/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpAuthorizationPreparationError,
  type Config,
  type McpAuthorizationHost,
  type MCPServerConfig,
} from '@qwen-code/core';
import {
  clearMcpAuthSession,
  getMcpAuthSession,
  getMcpCredentialState,
  isOAuthCapable,
  startMcpAuth,
} from './mcpAuthSession.js';

const coreMocks = vi.hoisted(() => ({
  lifecycleListeners: new Set<(name: string) => void>(),
  oauthProvider: vi.fn(),
  tokenStorage: Object.assign(vi.fn(), { forServer: vi.fn(() => ({})) }),
  openBrowserSecurely: vi.fn(async () => undefined),
  requestMcpAuthorizationConsent: vi.fn(async () => 'accepted' as const),
  requiresOAuth: new Map<string, boolean>(),
}));

function onServerAuthorizationInvalidated(listener: (name: string) => void) {
  coreMocks.lifecycleListeners.add(listener);
  return () => {
    coreMocks.lifecycleListeners.delete(listener);
  };
}

function invalidate(name: string) {
  for (const listener of coreMocks.lifecycleListeners) listener(name);
}

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    MCPServerStatus: { CONNECTED: 'connected' },
    MCPOAuthProvider: coreMocks.oauthProvider,
    MCPOAuthTokenStorage: coreMocks.tokenStorage,
    mcpServerRequiresOAuth: coreMocks.requiresOAuth,
    openBrowserSecurely: coreMocks.openBrowserSecurely,
    requestMcpAuthorizationConsent: coreMocks.requestMcpAuthorizationConsent,
  };
});

type TestAction = {
  type: 'open_url';
  serverId: string;
  connectionId: string;
  authorizationRequestId: string;
  url: URL;
  expiresAtMs: number;
};

class TestAuthorizationCoordinator {
  private action: TestAction | undefined;
  private recover: (() => Promise<void> | void) | undefined;

  constructor(
    private readonly options: {
      statusClient: { getStatus: () => Promise<{ status: string }> };
    },
  ) {}

  registerAction(
    _name: string,
    action: TestAction,
    recover: () => Promise<void> | void,
  ): void {
    this.action = action;
    this.recover = recover;
  }

  getAction(): TestAction | undefined {
    return this.action;
  }

  async authorize(
    _name: string,
    host: McpAuthorizationHost,
  ): Promise<
    | { state: 'completed' }
    | { state: 'expired'; canRetryAuthorization: true }
  > {
    if (this.action) {
      await host.openUrl(this.action.url, new AbortController().signal);
    }
    const status = await this.options.statusClient.getStatus();
    if (status.status !== 'succeeded') {
      this.action = undefined;
      return { state: 'expired', canRetryAuthorization: true };
    }
    await this.recover?.();
    this.action = undefined;
    return { state: 'completed' };
  }

  dispose(): void {}
}

describe('managed MCP TUI auth session', () => {
  const serverName = 'managed';
  const serverConfig: MCPServerConfig & { hostEndpoint: string } = {
    hostEndpoint: 'https://gateway.example/mcp/connections/one',
  };
  const authorizationManager = <T extends object>(manager: T) => ({
    prepareMcpAuthorization: async () => {
      throw new McpAuthorizationPreparationError('unsupported');
    },
    ...manager,
  });

  afterEach(() => {
    clearMcpAuthSession(serverName);
    coreMocks.requiresOAuth.clear();
    vi.clearAllMocks();
  });

  it.each(['completed', 'cancelled'] as const)(
    'clears terminal %s state without a mounted dialog or a client',
    async (state) => {
      const manager = {
        onServerAuthorizationInvalidated,
        prepareMcpAuthorization: vi.fn(async () => ({ kind: 'action' })),
        authorizeMcpServer: vi.fn(async () => ({ state })),
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(),
      } as unknown as Config;
      await startMcpAuth(serverName, serverConfig, config);
      expect(getMcpAuthSession(serverName).state).toBe(
        state === 'completed' ? 'success' : 'error',
      );
      invalidate('another-server');
      expect(getMcpAuthSession(serverName).state).not.toBe('idle');
      invalidate(serverName);
      expect(getMcpAuthSession(serverName).state).toBe('idle');
      expect(coreMocks.lifecycleListeners.size).toBe(0);
    },
  );

  it.each(['completed', 'cancelled', 'rejected'] as const)(
    'ignores invalidated %s and only allows a new task after the old task settles',
    async (result) => {
      let finishOld!: () => void;
      let finishNew!: () => void;
      let oldHost!: McpAuthorizationHost;
      const oldOutcome = new Promise((resolve, reject) => {
        finishOld = () =>
          result === 'rejected'
            ? reject(new Error('late failure'))
            : resolve({ state: result });
      });
      const newOutcome = new Promise((resolve) => {
        finishNew = () => resolve({ state: 'completed' });
      });
      const manager = {
        onServerAuthorizationInvalidated,
        prepareMcpAuthorization: vi.fn(async () => ({ kind: 'action' })),
        authorizeMcpServer: vi
          .fn((_name, host) => {
            oldHost = host;
            return oldOutcome;
          })
          .mockImplementationOnce((_name, host) => {
            oldHost = host;
            return oldOutcome;
          })
          .mockImplementationOnce(() => newOutcome),
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(),
      } as unknown as Config;
      const oldTask = startMcpAuth(serverName, serverConfig, config);
      await vi.waitFor(() =>
        expect(manager.authorizeMcpServer).toHaveBeenCalledOnce(),
      );
      invalidate(serverName);
      expect(getMcpAuthSession(serverName).state).toBe('idle');
      await startMcpAuth(serverName, serverConfig, config);
      expect(manager.authorizeMcpServer).toHaveBeenCalledOnce();
      oldHost.onStateChanged?.({ serverNames: [serverName], state: 'polling' });
      finishOld();
      await oldTask;
      expect(getMcpAuthSession(serverName).state).toBe('idle');
      expect(config.refreshMcpContext).not.toHaveBeenCalled();
      const newTask = startMcpAuth(serverName, serverConfig, config);
      await vi.waitFor(() =>
        expect(manager.authorizeMcpServer).toHaveBeenCalledTimes(2),
      );
      const newState = getMcpAuthSession(serverName);
      oldHost.onStateChanged?.({ serverNames: [serverName], state: 'polling' });
      expect(getMcpAuthSession(serverName)).toBe(newState);
      await startMcpAuth(serverName, serverConfig, config);
      expect(manager.authorizeMcpServer).toHaveBeenCalledTimes(2);
      finishNew();
      await newTask;
      expect(getMcpAuthSession(serverName).state).toBe('success');
      expect(config.refreshMcpContext).toHaveBeenCalledOnce();
    },
  );

  it('does not authorize a late preparation result after invalidation', async () => {
    let finish!: () => void;
    const preparation = new Promise((resolve) => {
      finish = () => resolve({ kind: 'action' });
    });
    const manager = {
      onServerAuthorizationInvalidated,
      prepareMcpAuthorization: vi.fn(() => preparation),
      authorizeMcpServer: vi.fn(),
    };
    const config = {
      getMcpClientManager: () => authorizationManager(manager),
      refreshMcpContext: vi.fn(),
    } as unknown as Config;
    const task = startMcpAuth(serverName, serverConfig, config);
    invalidate(serverName);
    finish();
    await task;
    expect(manager.authorizeMcpServer).not.toHaveBeenCalled();
    expect(config.refreshMcpContext).not.toHaveBeenCalled();
    expect(getMcpAuthSession(serverName).state).toBe('idle');
  });

  it.each([false, true])(
    'handles ordinary OAuth completion with invalidation=%s',
    async (invalidated) => {
      let finish!: () => void;
      const authentication = new Promise((resolve) => {
        finish = () => resolve({});
      });
      coreMocks.oauthProvider.mockImplementation(() => ({
        authenticate: () => authentication,
      }));
      const manager = {
        onServerAuthorizationInvalidated,
        restartServer: vi.fn(),
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(),
      } as unknown as Config;
      const task = startMcpAuth(
        serverName,
        { url: 'https://provider.example/mcp', oauth: { enabled: true } },
        config,
      );
      if (invalidated) invalidate(serverName);
      finish();
      await task;
      if (invalidated) {
        expect(manager.restartServer).not.toHaveBeenCalled();
        expect(config.refreshMcpContext).not.toHaveBeenCalled();
        expect(getMcpAuthSession(serverName).state).toBe('idle');
      } else {
        expect(manager.restartServer).toHaveBeenCalledWith(serverName, false, {
          preserveAuthorization: true,
        });
        expect(getMcpAuthSession(serverName).state).toBe('success');
      }
    },
  );

  it.each(['completed', 'timeout'] as const)(
    'keeps the ordinary OAuth running lock across UI cleanup until %s',
    async (outcome) => {
      let settle!: () => void;
      const pending = new Promise((resolve, reject) => {
        settle = () =>
          outcome === 'timeout'
            ? reject(new Error('OAuth callback timeout'))
            : resolve({});
      });
      const authenticate = vi
        .fn()
        .mockImplementationOnce(() => pending)
        .mockResolvedValue({});
      coreMocks.oauthProvider.mockImplementation(() => ({ authenticate }));
      const manager = {
        onServerAuthorizationInvalidated,
        restartServer: vi.fn(),
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(),
      } as unknown as Config;
      const directConfig: MCPServerConfig = {
        url: 'https://provider.example/mcp',
        oauth: { enabled: true, callbackPort: 18765 },
      };
      const oldTask = startMcpAuth(serverName, directConfig, config);
      try {
        await vi.waitFor(() =>
          expect(authenticate).toHaveBeenCalledOnce(),
        );
        invalidate(serverName);
        expect(getMcpAuthSession(serverName).state).toBe('idle');
        expect(coreMocks.lifecycleListeners.size).toBe(0);
        // Disable/reload/remove can clear the UI, but cannot stop this provider.
        // A second invocation must not attempt to bind its callback port again.
        clearMcpAuthSession(serverName);
        await startMcpAuth(serverName, directConfig, config);
        expect(authenticate).toHaveBeenCalledOnce();
        expect(getMcpAuthSession(serverName).state).toBe('idle');
        settle();
        await oldTask;
        expect(getMcpAuthSession(serverName).state).toBe('idle');
        expect(manager.restartServer).not.toHaveBeenCalled();
        expect(config.refreshMcpContext).not.toHaveBeenCalled();
        // Only the old task's finally releases the lock, on success or timeout.
        await startMcpAuth(serverName, directConfig, config);
        expect(authenticate).toHaveBeenCalledTimes(2);
        expect(getMcpAuthSession(serverName).state).toBe('success');
        expect(manager.restartServer).toHaveBeenCalledOnce();
      } finally {
        settle();
        await oldTask;
      }
    },
  );

  it('is OAuth-capable without consulting provider credential storage', async () => {
    coreMocks.requiresOAuth.set(serverName, true);

    expect(isOAuthCapable(serverName, serverConfig)).toBe(true);
    await expect(
      getMcpCredentialState(serverName, serverConfig),
    ).resolves.toBe('unauthenticated');
    expect(coreMocks.tokenStorage.forServer).not.toHaveBeenCalled();
  });

  it('opens the supplied action and completes through the manager coordinator', async () => {
    const action = {
      type: 'open_url' as const,
      serverId: 'server-id',
      connectionId: 'connection-id',
      authorizationRequestId: 'request-id',
      url: new URL('https://provider.example/authorize?state=opaque'),
      expiresAtMs: Date.now() + 60_000,
    };
    const openController = new AbortController();
    const authorizeMcpServer = vi.fn(
      async (_serverName: string, host: McpAuthorizationHost) => {
        await host.confirmOpenUrl(serverName, action, openController.signal);
        await host.openUrl(action.url, openController.signal);
        host.onStateChanged?.({ serverNames: [serverName], state: 'polling' });
        return { state: 'completed' as const };
      },
    );
    const manager = {
      onServerAuthorizationInvalidated,
      prepareMcpAuthorization: vi.fn(async () => ({
        kind: 'action' as const,
        action,
      })),
      authorizeMcpServer,
      restartServer: vi.fn(async () => undefined),
    };
    const config = {
      getMcpClientManager: () => authorizationManager(manager),
      refreshMcpContext: vi.fn(async () => undefined),
    } as unknown as Config;

    await startMcpAuth(serverName, serverConfig, config);

    expect(authorizeMcpServer).toHaveBeenCalledOnce();
    expect(coreMocks.requestMcpAuthorizationConsent).toHaveBeenCalledWith(
      serverName,
      action,
      openController.signal,
    );
    expect(manager.restartServer).not.toHaveBeenCalled();
    expect(coreMocks.openBrowserSecurely).toHaveBeenCalledWith(
      action.url.href,
      openController.signal,
    );
    expect(coreMocks.oauthProvider).not.toHaveBeenCalled();
    expect(getMcpAuthSession(serverName).state).toBe('success');
  });

  it.each(['missing', 'expired'] as const)(
    'reconnects for a fresh action when the previous action is %s',
    async (initialActionState) => {
      const expiredAction = {
        type: 'open_url' as const,
        serverId: 'server-id',
        connectionId: 'connection-id',
        authorizationRequestId: 'expired-request',
        url: new URL('https://provider.example/expired'),
        expiresAtMs: Date.now() - 1,
      };
      const freshAction = {
        ...expiredAction,
        authorizationRequestId: 'fresh-request',
        url: new URL('https://provider.example/fresh'),
        expiresAtMs: Date.now() + 60_000,
      };
      let currentAction: typeof expiredAction | undefined =
        initialActionState === 'expired' ? expiredAction : undefined;
      const authorizeMcpServer = vi.fn(
        async (_serverName: string, host: McpAuthorizationHost) => {
          await host.openUrl(currentAction!.url, new AbortController().signal);
          return { state: 'completed' as const };
        },
      );
      const manager = {
        onServerAuthorizationInvalidated,
        prepareMcpAuthorization: vi.fn(async () => {
          currentAction = freshAction;
          return { kind: 'action' as const, action: freshAction };
        }),
        authorizeMcpServer,
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(async () => undefined),
      } as unknown as Config;

      await startMcpAuth(serverName, serverConfig, config);

      expect(manager.prepareMcpAuthorization).toHaveBeenCalledWith(
        serverName,
      );
      expect(authorizeMcpServer).toHaveBeenCalledOnce();
      expect(coreMocks.openBrowserSecurely).toHaveBeenCalledWith(
        freshAction.url.href,
        expect.any(AbortSignal),
      );
      expect(getMcpAuthSession(serverName).state).toBe('success');
    },
  );

  it.each([
    'connected',
    'fresh-action',
    'discovery-failed',
    'disabled',
  ] as const)(
    'retries after an expired session when reconnection is %s',
    async (outcome) => {
      const oldAction = {
        type: 'open_url' as const,
        serverId: 'server-id',
        connectionId: 'connection-id',
        authorizationRequestId: 'old-request',
        url: new URL('https://provider.example/old'),
        expiresAtMs: Date.now() + 60_000,
      };
      const freshAction = {
        ...oldAction,
        authorizationRequestId: 'fresh-request',
        url: new URL('https://provider.example/fresh'),
      };
      const getStatus = vi
        .fn()
        .mockResolvedValueOnce({ status: 'expired' })
        .mockResolvedValueOnce({ status: 'succeeded' });
      const coordinator = new TestAuthorizationCoordinator({
        statusClient: { getStatus },
      });
      const recover = vi.fn();
      coordinator.registerAction(serverName, oldAction, recover);
      const manager = {
        onServerAuthorizationInvalidated,
        authorizeMcpServer: vi.fn(
          (name: string, host: McpAuthorizationHost) =>
            coordinator.authorize(name, host),
        ),
        prepareMcpAuthorization: vi.fn(async () => {
          const action = coordinator.getAction();
          if (action) return { kind: 'action' as const, action };
          if (outcome === 'fresh-action') {
            coordinator.registerAction(serverName, freshAction, recover);
            return { kind: 'action' as const, action: freshAction };
          }
          if (outcome === 'disabled')
            throw new Error('Managed MCP server is unavailable or disabled.');
          if (outcome === 'discovery-failed') {
            throw new Error(
              'Managed MCP authorization could not be prepared. Retry authentication explicitly.',
            );
          }
          return { kind: 'connected' as const };
        }),
      };
      const config = {
        getMcpClientManager: () => authorizationManager(manager),
        refreshMcpContext: vi.fn(async () => undefined),
      } as unknown as Config;

      await startMcpAuth(serverName, serverConfig, config);
      expect(getMcpAuthSession(serverName)).toMatchObject({
        state: 'error',
        error: 'MCP authorization expired',
      });
      expect(coordinator.getAction()).toBeUndefined();
      expect(manager.prepareMcpAuthorization).toHaveBeenCalledOnce();
      expect(recover).not.toHaveBeenCalled();

      await startMcpAuth(serverName, serverConfig, config);

      expect(manager.prepareMcpAuthorization).toHaveBeenCalledTimes(2);
      const succeeded = outcome === 'connected' || outcome === 'fresh-action';
      expect(getMcpAuthSession(serverName).state).toBe(
        succeeded ? 'success' : 'error',
      );
      expect(config.refreshMcpContext).toHaveBeenCalledTimes(succeeded ? 1 : 0);
      expect(coreMocks.openBrowserSecurely).toHaveBeenCalledTimes(
        outcome === 'fresh-action' ? 2 : 1,
      );
      expect(getStatus).toHaveBeenCalledTimes(
        outcome === 'fresh-action' ? 2 : 1,
      );
      if (outcome === 'fresh-action') {
        expect(coreMocks.openBrowserSecurely).toHaveBeenLastCalledWith(
          freshAction.url.href,
          expect.any(AbortSignal),
        );
        expect(recover).toHaveBeenCalledOnce();
      }
      if (outcome === 'discovery-failed') {
        expect(getMcpAuthSession(serverName)).toMatchObject({
          error:
            'Managed MCP authorization could not be prepared. Retry authentication explicitly.',
        });
      }
      coordinator.dispose();
    },
  );
});
