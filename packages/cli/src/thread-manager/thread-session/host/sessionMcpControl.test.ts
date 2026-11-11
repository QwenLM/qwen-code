/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Config,
  type MCPServerConfig,
  type OAuthToken,
  ENV_FORCE_ENCRYPTED_FILE_STORAGE,
  MCPOAuthTokenStorage,
  Storage,
} from '@qwen-code/core';
import { createMcpControlModule } from './sessionMcpControl.js';

function controlFor(
  servers: Record<string, unknown> | undefined,
  managerServers: Record<string, unknown> | null = servers ?? null,
) {
  const config = {
    getMcpClientManager: () =>
      managerServers === null
        ? undefined
        : {
            getMcpServers: () => managerServers,
            restartServer: vi.fn(),
            storeAuthorizationToken: async (
              name: string,
              token: OAuthToken,
              serverConfig?: MCPServerConfig,
            ) => {
              if (serverConfig && Reflect.get(serverConfig, 'hostEndpoint') !== undefined) return 'host-owned';
              if (!serverConfig) return 'host-owned';
              const storage = MCPOAuthTokenStorage.forServer(
                name,
                serverConfig,
              );
              const existing = await storage.getCredentials(name);
              await storage.saveToken(
                name,
                token,
                serverConfig.oauth?.clientId ?? existing?.clientId,
                serverConfig.oauth?.tokenUrl ?? existing?.tokenUrl,
                serverConfig.httpUrl ?? serverConfig.url,
                serverConfig.oauth?.resource ?? existing?.resource,
              );
              return 'stored';
            },
            clearAuthorization: async (
              name: string,
              serverConfig?: MCPServerConfig,
            ) => {
              if (serverConfig && Reflect.get(serverConfig, 'hostEndpoint') !== undefined) return 'host-owned';
              if (serverConfig) {
                await MCPOAuthTokenStorage.forServer(
                  name,
                  serverConfig,
                ).deleteCredentials(name);
              } else {
                await MCPOAuthTokenStorage.deleteCredentialsByServerName(name);
              }
              return 'cleared';
            },
          },
    getMcpServers: () => servers,
    getSessionId: () => 'test-session',
  } as unknown as Config;
  return createMcpControlModule({
    config,
    runLogger: { log: () => {}, warn: () => {} },
  });
}

describe('mcp_inject_token', () => {
  it('refuses a server without config instead of guessing its identity', async () => {
    const control = controlFor({});

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'ghost',
        token: { accessToken: 'token' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'unknown MCP server "ghost"',
    });
  });
});

describe('mcp_inject_token storage', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mcp-inject-'));
    vi.stubEnv(ENV_FORCE_ENCRYPTED_FILE_STORAGE, 'false');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(directory);
    vi.spyOn(Storage, 'getMcpOAuthTokensPath').mockReturnValue(
      join(directory, 'tokens.json'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists the identity URL and configured OAuth fields', async () => {
    const config = {
      url: 'https://mcp.example.com/mcp',
      oauth: {
        enabled: true,
        clientId: 'client',
        tokenUrl: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp/',
      },
    };
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'A', refreshToken: 'R' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      mcpServerUrl: 'https://mcp.example.com/mcp',
      resource: 'https://mcp.example.com/mcp/',
      token: { accessToken: 'A', refreshToken: 'R' },
    });
  });

  it('keeps fields known from an earlier sign-in', async () => {
    const config = {
      url: 'https://mcp.example.com/mcp',
      oauth: { enabled: true },
    };
    await MCPOAuthTokenStorage.forServer('svc', config).saveToken(
      'svc',
      { accessToken: 'old', refreshToken: 'R0', tokenType: 'Bearer' },
      'client',
      'https://auth.example.com/token',
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/mcp/',
    );
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'new', refreshToken: 'R1' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({
      clientId: 'client',
      tokenUrl: 'https://auth.example.com/token',
      resource: 'https://mcp.example.com/mcp/',
      token: { accessToken: 'new', refreshToken: 'R1' },
    });
  });

  it('still stores the identity URL without OAuth config', async () => {
    const config = { url: 'https://mcp.example.com/mcp' };
    const control = controlFor({ svc: config });

    await expect(
      control.handle('mcp_inject_token', {
        serverName: 'svc',
        token: { accessToken: 'A' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(
      await MCPOAuthTokenStorage.forServer('svc', config).getCredentials('svc'),
    ).toMatchObject({ mcpServerUrl: 'https://mcp.example.com/mcp' });
  });
});

const serverA: MCPServerConfig = { url: 'https://a.example.com/mcp' };
const serverB: MCPServerConfig = { url: 'https://b.example.com/mcp' };
const pluginServer: MCPServerConfig = {
  ...serverA,
  plugin: { id: 'review@market', name: 'review', path: '/plugin' },
};

describe('mcp_clear_auth', () => {
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mcp-clear-auth-'));
    vi.stubEnv(ENV_FORCE_ENCRYPTED_FILE_STORAGE, 'false');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(directory);
    vi.spyOn(Storage, 'getMcpOAuthTokensPath').mockReturnValue(
      join(directory, 'tokens.json'),
    );
    for (const [config, accessToken] of [
      [serverA, 'token-a'],
      [serverB, 'token-b'],
      [pluginServer, 'plugin-token'],
    ] as const) {
      await MCPOAuthTokenStorage.forServer('svc', config).saveToken('svc', {
        accessToken,
        tokenType: 'Bearer',
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  async function remainingTokens(): Promise<string[]> {
    const credentials = await new MCPOAuthTokenStorage().getAllCredentials();
    return [...credentials.values()]
      .map(({ token }) => token.accessToken)
      .sort();
  }

  it.each([
    ['manager missing', null],
    ['manager catalogue empty', {}],
  ] as const)('clears only the configured identity when %s', async (_name, managerServers) => {
    const control = controlFor({ svc: serverA }, managerServers);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token', 'token-b']);
  });

  it('prefers the manager entry over the Config entry', async () => {
    const control = controlFor({ svc: serverB }, { svc: serverA });

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token', 'token-b']);
  });

  it('rejects brokered-server cleanup when the manager handles it', async () => {
    const control = controlFor(
      { svc: { hostEndpoint: 'https://mcp.example.com/test' } },
      {},
    );

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({
      ok: false,
      error:
        'MCP authorization for this server is owned by the host; local OAuth credentials cannot be cleared.',
    });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });

  it('clears local credentials when no manager can own the authorization', async () => {
    const control = controlFor(
      { svc: { hostEndpoint: 'https://mcp.example.com/test' } },
      null,
    );

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });

  it('retains name-wide cleanup for a genuinely unknown server', async () => {
    const control = controlFor({});

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token']);
  });

  it.each([
    ['manager missing', null],
    ['manager catalogue empty', {}],
  ] as const)('handles undefined Config servers when %s', async (_name, managerServers) => {
    const control = controlFor(undefined, managerServers);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({ ok: true });

    expect(await remainingTokens()).toEqual(['plugin-token']);
  });

  it('reports storage failure without deleting credentials', async () => {
    const control = controlFor({ svc: serverA }, {});
    vi.spyOn(MCPOAuthTokenStorage, 'forServer').mockReturnValue({
      deleteCredentials: vi.fn().mockRejectedValue(new Error('lock lost')),
    } as unknown as MCPOAuthTokenStorage);

    await expect(
      control.handle('mcp_clear_auth', { serverName: 'svc' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Failed to delete credentials: lock lost',
    });

    expect(await remainingTokens()).toEqual([
      'plugin-token',
      'token-a',
      'token-b',
    ]);
  });
});
