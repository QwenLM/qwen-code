/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMcpOAuthBrowserOpener,
  MCPServerStatus,
  mcpServerKeyId,
  pluginMcpRegistrations,
  type MCPOAuthConfig,
  type McpManager,
  type McpOAuthBrowserOpenResult,
  type McpServerKey,
  type McpServerRegistration,
  type OAuthToken,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import {
  registerMcpOAuthOpener,
  unregisterMcpOAuthOpener,
} from '@qwen-code/core';
import { userMcpServerKey } from '../../../mcp/framework.js';
import { DaemonMcpAuthorization } from './authorization.js';
import type { DaemonMcpContext } from './context.js';

const TOKEN: OAuthToken = { accessToken: 'at', tokenType: 'Bearer' };
const REDIRECT = 'http://127.0.0.1:53682/oauth/callback';

interface ProviderCall {
  name: string;
  config: MCPOAuthConfig;
  serverUrl: string | undefined;
  options: unknown;
  /** What the opener handed back to core for this call. */
  openerResult?: Promise<McpOAuthBrowserOpenResult | void>;
}

/**
 * Stands in for core's provider: reaches the browser step through the
 * process-wide opener exactly like `MCPOAuthProvider.authenticate`, then
 * "exchanges" the code unless told to fail.
 */
function fakeProvider(
  behavior: {
    silent?: boolean;
    exchangeError?: Error;
    /** Holds the code exchange open until it settles. */
    exchangeGate?: Promise<void>;
    /** Holds discovery (before the browser step) open until it settles. */
    discoveryGate?: Promise<void>;
    /** Called where core would save the token. */
    onSaved?: (name: string, token: OAuthToken) => void;
  } = {},
) {
  const calls: ProviderCall[] = [];
  const createProvider = () => ({
    authenticate: async (
      name: string,
      config: MCPOAuthConfig,
      serverUrl?: string,
      options?: unknown,
    ) => {
      const call: ProviderCall = { name, config, serverUrl, options };
      calls.push(call);
      await Promise.resolve();
      await behavior.discoveryGate;
      if (behavior.silent) return TOKEN;
      const opener = getMcpOAuthBrowserOpener();
      if (!opener) throw new Error('no opener installed');
      call.openerResult = opener(
        `https://auth.example.com/authorize?s=${name}`,
        {
          serverName: name,
          flowId: (options as { flowId?: string })?.flowId,
          state: 'state',
        },
      );
      const result = await call.openerResult;
      if (!result || !('callbackUrl' in result)) {
        throw new Error('expected a callback URL');
      }
      const url = new URL(result.callbackUrl);
      const error = url.searchParams.get('error');
      if (error) throw new Error(`OAuth error: ${error}`);
      await behavior.exchangeGate;
      if (behavior.exchangeError) throw behavior.exchangeError;
      // Each sign-in gets its own token, as a real exchange would.
      const token = { ...TOKEN, accessToken: `at-${calls.length}` };
      behavior.onSaved?.(name, token);
      return token;
    },
  });
  return { calls, createProvider };
}

function setup(options: {
  raw?: Record<string, unknown>;
  pooled?: string[];
  plugins?: Array<{
    pluginId: string;
    name: string;
    config: Record<string, unknown>;
  }>;
  credentials?: string[];
}) {
  const raw = options.raw ?? {};
  const settings = {
    isUserSettingsLoadRejected: () => false,
    user: {
      originalSettings: { mcpServers: raw },
      settings: { mcpServers: raw },
    },
  } as unknown as LoadedSettings;
  const reconnect = vi.fn(async (_key: McpServerKey, _auth?: boolean) => {});
  const pooled = new Map<string, unknown>();
  const client = (key: McpServerKey, config: object) => ({
    getServerKey: () => key,
    getServerName: () => key.name,
    getServerConfig: () => config,
    getStatus: () => MCPServerStatus.AUTH_REQUIRED,
    getLastConnectError: () => undefined,
  });
  for (const name of options.pooled ?? []) {
    const key = userMcpServerKey(name);
    pooled.set(mcpServerKeyId(key), client(key, {}));
  }
  const userRegistrations: McpServerRegistration[] = [];
  for (const plugin of options.plugins ?? []) {
    const [registration] = pluginMcpRegistrations(
      {
        id: plugin.pluginId,
        name: 'p',
        path: '/p',
        mcpServers: { [plugin.name]: plugin.config },
      },
      '/p',
    );
    userRegistrations.push(registration);
    pooled.set(
      mcpServerKeyId(registration.key),
      client(registration.key, registration.config),
    );
  }
  const manager = {
    getClient: (key: McpServerKey) => pooled.get(mcpServerKeyId(key)),
    getClients: () => [...pooled.values()],
    reconnect,
  } as unknown as McpManager;
  /** Stored credentials: server name → access token. */
  const credentials = new Map(
    (options.credentials ?? []).map((name) => [name, TOKEN.accessToken]),
  );
  const deleteCredentials = vi.fn(async (name: string) =>
    credentials.delete(name),
  );
  const context: DaemonMcpContext = {
    getMcpManager: () => manager,
    readUserSettings: () => settings,
    hasCredentials: async (name) => credentials.has(name),
    deleteCredentials,
    deleteCredentialsIfToken: async (name, token) => {
      if (credentials.get(name) === token.accessToken) credentials.delete(name);
    },
    userRegistrations: () => userRegistrations,
    syncPool: async () => {},
  };
  return { context, reconnect, deleteCredentials, credentials, raw };
}

const live: DaemonMcpAuthorization[] = [];
function create(
  context: DaemonMcpContext,
  provider: ReturnType<typeof fakeProvider>,
  extra: { ttlMs?: number; now?: () => number; settleWaitMs?: number } = {},
): DaemonMcpAuthorization {
  const auth = new DaemonMcpAuthorization(context, {
    createProvider: provider.createProvider as never,
    ...extra,
  });
  live.push(auth);
  return auth;
}

afterEach(() => {
  for (const auth of live.splice(0)) auth.dispose();
  vi.useRealTimers();
});

const remote = {
  github: { url: 'https://mcp.example.com/mcp', oauth: { scopes: ['repo'] } },
};

describe('DaemonMcpAuthorization.authenticate', () => {
  it('returns the authorization URL and runs the flow with the host redirect', async () => {
    const { context } = setup({ raw: remote });
    const provider = fakeProvider();
    const auth = create(context, provider, { now: () => 1_000, ttlMs: 5_000 });

    const start = await auth.authenticate('user:github', {
      redirectUri: REDIRECT,
    });

    expect(start).toEqual({
      requiresUserAction: true,
      authUrl: 'https://auth.example.com/authorize?s=github',
      expiresAt: 6_000,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      name: 'github',
      serverUrl: 'https://mcp.example.com/mcp',
      config: { enabled: true, redirectUri: REDIRECT, scopes: ['repo'] },
      options: { skipConsent: true },
    });
  });

  it('returns the same URL while the flow waits for the user', async () => {
    const { context } = setup({ raw: remote });
    const provider = fakeProvider();
    const auth = create(context, provider);

    const first = await auth.authenticate('user:github', {
      redirectUri: REDIRECT,
    });
    const second = await auth.authenticate('user:github', {
      redirectUri: REDIRECT,
    });

    expect(second.authUrl).toBe(first.authUrl);
    expect(provider.calls).toHaveLength(1);
  });

  it('needs no user action when stored credentials were enough', async () => {
    const { context, reconnect } = setup({ raw: remote, pooled: ['github'] });
    const auth = create(context, fakeProvider({ silent: true }));

    await expect(
      auth.authenticate('user:github', { redirectUri: REDIRECT }),
    ).resolves.toEqual({ requiresUserAction: false });
    expect(reconnect).toHaveBeenCalledWith(userMcpServerKey('github'), false);
  });

  it('authorizes a plugin server by its pool key', async () => {
    const { context } = setup({
      plugins: [
        {
          pluginId: 'linear@market',
          name: 'linear',
          config: { url: 'https://mcp.linear.app/mcp' },
        },
      ],
    });
    const provider = fakeProvider();
    const auth = create(context, provider);

    const start = await auth.authenticate('plugin:linear%40market:linear', {
      redirectUri: REDIRECT,
    });

    expect(start.requiresUserAction).toBe(true);
    expect(provider.calls[0]?.serverUrl).toBe('https://mcp.linear.app/mcp');
  });

  it.each([
    [
      'a stdio server',
      { local: { command: 'node' } },
      'user:local',
      'UNSUPPORTED',
    ],
    [
      'a gateway server',
      { managed: { qoder_url: 'https://mcp.qoder.com/x' } },
      'user:managed',
      'UNSUPPORTED',
    ],
    [
      'a disabled server',
      { off: { url: 'https://x', disabled: true } },
      'user:off',
      'DISABLED',
    ],
    ['an unknown server', {}, 'user:nope', 'NOT_FOUND'],
  ])('rejects %s', async (_label, raw, serverId, code) => {
    const { context } = setup({ raw });
    const provider = fakeProvider();
    const auth = create(context, provider);

    await expect(
      auth.authenticate(serverId, { redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('DaemonMcpAuthorization.submitCallback', () => {
  it('hands core the callback, then reconnects the pooled server', async () => {
    const { context, reconnect } = setup({ raw: remote, pooled: ['github'] });
    const provider = fakeProvider();
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    const server = await auth.submitCallback(
      'user:github',
      `${REDIRECT}?code=abc&state=state`,
    );

    await expect(provider.calls[0]?.openerResult).resolves.toEqual({
      callbackUrl: `${REDIRECT}?code=abc&state=state`,
    });
    expect(reconnect).toHaveBeenCalledWith(userMcpServerKey('github'), false);
    expect(server.serverId).toBe('user:github');
    // The flow is over: the process-wide opener slot is free again.
    expect(getMcpOAuthBrowserOpener()).toBeNull();
  });

  it('reports a failed exchange as AUTH_FAILED', async () => {
    const { context } = setup({ raw: remote });
    const auth = create(
      context,
      fakeProvider({ exchangeError: new Error('invalid_grant') }),
    );
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    await expect(
      auth.submitCallback('user:github', `${REDIRECT}?code=bad`),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('rejects a callback with no flow waiting for it', async () => {
    const { context } = setup({ raw: remote });
    const auth = create(context, fakeProvider());

    await expect(
      auth.submitCallback('user:github', `${REDIRECT}?code=abc`),
    ).rejects.toMatchObject({ code: 'NOT_IN_PROGRESS' });
  });
});

describe('DaemonMcpAuthorization.cancel', () => {
  it('ends a waiting flow with an OAuth error instead of a browser fallback', async () => {
    const { context } = setup({ raw: remote });
    const provider = fakeProvider();
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    expect(auth.cancel('user:github')).toEqual({ cancelled: true });

    const result = await provider.calls[0]?.openerResult;
    expect(result).toMatchObject({
      callbackUrl: expect.stringContaining('error=access_denied'),
    });
    await vi.waitFor(() => expect(getMcpOAuthBrowserOpener()).toBeNull());
    expect(auth.cancel('user:github')).toEqual({
      cancelled: false,
      reason: 'not_in_progress',
    });
  });

  it('cannot cancel once the code exchange started', async () => {
    const { context } = setup({ raw: remote });
    const auth = create(context, fakeProvider());
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    const submitted = auth.submitCallback(
      'user:github',
      `${REDIRECT}?code=abc`,
    );

    expect(auth.cancel('user:github')).toEqual({
      cancelled: false,
      reason: 'completing',
    });
    await submitted;
  });

  it('drops a flow nobody finished after the time limit', async () => {
    vi.useFakeTimers();
    const { context } = setup({ raw: remote });
    const provider = fakeProvider();
    const auth = create(context, provider, { ttlMs: 1_000 });
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(provider.calls[0]?.openerResult).resolves.toMatchObject({
      callbackUrl: expect.stringContaining('error=access_denied'),
    });
    expect(auth.cancel('user:github').cancelled).toBe(false);
  });
});

describe('DaemonMcpAuthorization.clear', () => {
  it('deletes credentials, ends a waiting flow, and reconnects', async () => {
    const { context, reconnect, deleteCredentials } = setup({
      raw: remote,
      pooled: ['github'],
      credentials: ['github'],
    });
    const provider = fakeProvider();
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    const result = await auth.clear('user:github');

    expect(result.credentialsDeleted).toBe(true);
    expect(result.server.hasCredentials).toBe(false);
    expect(deleteCredentials).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ url: 'https://mcp.example.com/mcp' }),
    );
    expect(reconnect).toHaveBeenCalledWith(userMcpServerKey('github'), false);
    await expect(provider.calls[0]?.openerResult).resolves.toMatchObject({
      callbackUrl: expect.stringContaining('error=access_denied'),
    });
  });

  it('clears a disabled server without reconnecting it', async () => {
    const { context, reconnect, deleteCredentials } = setup({
      raw: { github: { url: 'https://mcp.example.com/mcp', disabled: true } },
      credentials: ['github'],
    });
    const auth = create(context, fakeProvider());

    const result = await auth.clear('user:github');

    expect(result.credentialsDeleted).toBe(true);
    expect(deleteCredentials).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ disabled: true }),
    );
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('still refuses to start an authorization for a disabled server', async () => {
    const { context } = setup({
      raw: { github: { url: 'https://mcp.example.com/mcp', disabled: true } },
    });
    const auth = create(context, fakeProvider());

    await expect(
      auth.authenticate('user:github', { redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('refuses gateway servers, whose credentials are not local', async () => {
    const { context } = setup({
      raw: { managed: { qoder_url: 'https://mcp.qoder.com/x' } },
    });
    const auth = create(context, fakeProvider());

    await expect(auth.clear('user:managed')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('DaemonMcpAuthorization: delete and clear during a flow (D07)', () => {
  it('a delete ends a flow still waiting for the user', async () => {
    const { context } = setup({ raw: { ...remote } });
    const provider = fakeProvider();
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });

    await auth.settleUserServer('github');

    await expect(provider.calls[0]?.openerResult).resolves.toMatchObject({
      callbackUrl: expect.stringContaining('error=access_denied'),
    });
    await expect(
      auth.submitCallback('user:github', `${REDIRECT}?code=late`),
    ).rejects.toMatchObject({ code: 'NOT_IN_PROGRESS' });
  });

  it('a token saved for a server deleted mid-exchange is removed again', async () => {
    const exchange = gate();
    const { context, credentials, raw } = setup({ raw: { ...remote } });
    const provider = fakeProvider({
      exchangeGate: exchange.promise,
      onSaved: (name, token) => credentials.set(name, token.accessToken),
    });
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });
    const submitted = auth.submitCallback(
      'user:github',
      `${REDIRECT}?code=abc`,
    );
    submitted.catch(() => {});

    // The delete wrote settings first, then settles the flow.
    delete raw['github'];
    let settled = false;
    const settling = auth
      .settleUserServer('github')
      .then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    exchange.open();
    await settling;

    expect(credentials.has('github')).toBe(false);
    await expect(submitted).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('clear during an exchange: the ended flow takes back its token', async () => {
    const exchange = gate();
    const { context, credentials } = setup({
      raw: { ...remote },
      pooled: ['github'],
    });
    const provider = fakeProvider({
      exchangeGate: exchange.promise,
      onSaved: (name, token) => credentials.set(name, token.accessToken),
    });
    const auth = create(context, provider);
    await auth.authenticate('user:github', { redirectUri: REDIRECT });
    const submitted = auth.submitCallback(
      'user:github',
      `${REDIRECT}?code=abc`,
    );
    submitted.catch(() => {});

    const clearing = auth.clear('user:github');
    exchange.open();
    await clearing;

    expect(credentials.has('github')).toBe(false);
    await expect(submitted).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('clear past the wait bound: a token saved later is still taken back', async () => {
    const exchange = gate();
    const { context, credentials } = setup({
      raw: { ...remote },
      pooled: ['github'],
    });
    const provider = fakeProvider({
      exchangeGate: exchange.promise,
      onSaved: (name, token) => credentials.set(name, token.accessToken),
    });
    const auth = create(context, provider, { settleWaitMs: 5 });
    await auth.authenticate('user:github', { redirectUri: REDIRECT });
    const submitted = auth.submitCallback(
      'user:github',
      `${REDIRECT}?code=abc`,
    );
    submitted.catch(() => {});

    const result = await auth.clear('user:github');
    expect(result.credentialsDeleted).toBe(false);

    exchange.open();
    await expect(submitted).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(credentials.has('github')).toBe(false);
  });

  it('a sign-in started right after clear waits for the ended flow and keeps its own token', async () => {
    const exchange = gate();
    const { context, credentials } = setup({
      raw: { ...remote },
      pooled: ['github'],
    });
    const provider = fakeProvider({
      exchangeGate: exchange.promise,
      onSaved: (name, token) => credentials.set(name, token.accessToken),
    });
    const auth = create(context, provider, { settleWaitMs: 5 });
    await auth.authenticate('user:github', { redirectUri: REDIRECT });
    void auth
      .submitCallback('user:github', `${REDIRECT}?code=old`)
      .catch(() => {});
    await auth.clear('user:github');

    const restarting = auth.authenticate('user:github', {
      redirectUri: REDIRECT,
    });
    exchange.open();
    // A fresh flow with its own URL, not the ended one's.
    await expect(restarting).resolves.toMatchObject({
      requiresUserAction: true,
    });
    expect(provider.calls).toHaveLength(2);

    await auth.submitCallback('user:github', `${REDIRECT}?code=new`);
    expect(credentials.get('github')).toBe('at-2');
  });

  it('clear before the browser step: the ended flow is not handed to another opener', async () => {
    const discovery = gate();
    const { context } = setup({ raw: { ...remote } });
    const provider = fakeProvider({ discoveryGate: discovery.promise });
    const auth = create(context, provider);
    const starting = auth.authenticate('user:github', {
      redirectUri: REDIRECT,
    });
    starting.catch(() => {});
    await Promise.resolve();
    // Another session's opener, asked only when the daemon has no flow.
    const other = vi.fn(async () => ({
      callbackUrl: `${REDIRECT}?code=stolen`,
    }));
    const otherKey = registerMcpOAuthOpener(other);
    try {
      const clearing = auth.clear('user:github');
      discovery.open();
      await clearing;
      await expect(starting).rejects.toMatchObject({ code: 'AUTH_FAILED' });
      expect(other).not.toHaveBeenCalled();
    } finally {
      unregisterMcpOAuthOpener(otherKey);
    }
  });

  it('stops waiting for a stuck exchange after the bound', async () => {
    vi.useFakeTimers();
    const { context } = setup({ raw: { ...remote } });
    const provider = fakeProvider({ exchangeGate: new Promise(() => {}) });
    const auth = create(context, provider, { settleWaitMs: 1_000 });
    await auth.authenticate('user:github', { redirectUri: REDIRECT });
    void auth
      .submitCallback('user:github', `${REDIRECT}?code=abc`)
      .catch(() => {});

    let settled = false;
    const settling = auth
      .settleUserServer('github')
      .then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settling;
    expect(settled).toBe(true);
  });
});


it('routes same-name parallel authorizations by flow id even when browser steps arrive in reverse order', async () => {
  const discovery = gate();
  const firstContext = setup({ raw: { ...remote } }).context;
  const secondContext = setup({ raw: { ...remote } }).context;
  const firstProvider = fakeProvider({ discoveryGate: discovery.promise });
  const secondProvider = fakeProvider();
  const first = create(firstContext, firstProvider);
  const second = create(secondContext, secondProvider);
  const startedFirst = first.authenticate('user:github', {
    redirectUri: REDIRECT,
  });
  await second.authenticate('user:github', { redirectUri: REDIRECT });
  expect(firstProvider.calls[0]?.openerResult).toBeUndefined();
  discovery.open();
  await startedFirst;
  await second.submitCallback('user:github', `${REDIRECT}?code=second`);
  await first.submitCallback('user:github', `${REDIRECT}?code=first`);
  expect(await firstProvider.calls[0]!.openerResult).toEqual({
    callbackUrl: `${REDIRECT}?code=first`,
  });
  expect(await secondProvider.calls[0]!.openerResult).toEqual({
    callbackUrl: `${REDIRECT}?code=second`,
  });
});
