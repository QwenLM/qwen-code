/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCPOAuthTokenStorage,
  Storage,
  mcpServerKeyId,
  pluginMcpRegistrations,
  type MCPServerConfig,
  type McpManager,
  type McpServerKey,
} from '@qwen-code/core';
import type { SettingsService } from '@qwen-code/resource';
import type { LoadedSettings } from '../../../config/settings.js';
import { DaemonMcpService } from './daemonMcpService.js';
import { pluginMcpServerId } from './serverIds.js';

const USER_URL = 'https://user.example.com/mcp';
const PLUGIN_URL = 'https://plugin.example.com/mcp';
const token = (accessToken: string) => ({ accessToken, tokenType: 'Bearer' });

const owner = {
  id: 'p@market',
  name: 'p',
  path: '/plugins/p',
  mcpServers: { shared: { url: PLUGIN_URL } },
};
const [registration] = pluginMcpRegistrations(owner, '/plugins/p');
const userConfig: MCPServerConfig = { url: USER_URL };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-mcp-cred-'));
  vi.spyOn(Storage, 'getMcpOAuthTokensPath').mockReturnValue(
    join(root, 'mcp-oauth-tokens.json'),
  );
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function settings(mcpServers: Record<string, unknown> = {}): LoadedSettings {
  return {
    isUserSettingsLoadRejected: () => false,
    user: {
      originalSettings: { mcpServers },
      settings: { mcpServers },
    },
  } as unknown as LoadedSettings;
}

function setup(
  servers: Record<string, unknown> = {},
  startup: ReadonlyArray<typeof registration> = [],
) {
  const reconnect = vi.fn(async () => {});
  const client = {
    getServerKey: () => registration.key,
    getServerName: () => registration.key.name,
    getServerConfig: () => registration.config,
    getStatus: () => 'auth_required',
    getLastConnectError: () => undefined,
  };
  const manager = {
    getClient: (key: McpServerKey) =>
      mcpServerKeyId(key) === mcpServerKeyId(registration.key)
        ? client
        : undefined,
    getClients: () => [client],
    reconnect,
  } as unknown as McpManager;
  const settingsService = {
    peekUserSettingsSource: () => undefined,
    resolve: () => settings(servers),
  };
  const service = new DaemonMcpService({
    getMcpManager: () => manager,
    getSettingsService: () => settingsService as unknown as SettingsService,
    startupUserServers: () => startup,
    refreshSessions: async () => [],
  });
  return { service, reconnect };
}

const userStorage = () => MCPOAuthTokenStorage.forServer('shared', userConfig);
const pluginStorage = () =>
  MCPOAuthTokenStorage.forServer('shared', registration.config);

describe('daemon clear targets one identity', () => {
  it('a plugin clear leaves the user credential of the same name alone', async () => {
    await userStorage().saveToken('shared', token('user-token'));
    await pluginStorage().saveToken('shared', token('plugin-token'));
    // The key the first plugin scheme stored under; a save above may have
    // removed an older one, so write it last.
    const raw = new MCPOAuthTokenStorage();
    await raw.saveToken('plugin:p:shared', token('old-plugin-token'));

    const { service } = setup({}, [registration]);
    const result = await service.auth({
      action: 'clear',
      serverId: pluginMcpServerId('p@market', 'shared'),
    });

    expect((result as { credentialsDeleted?: boolean }).credentialsDeleted).toBe(
      true,
    );
    expect(
      (await userStorage().getCredentials('shared'))?.token.accessToken,
    ).toBe('user-token');
    expect(await pluginStorage().getCredentials('shared')).toBeNull();
    expect(await raw.getCredentials('plugin:p:shared')).toBeNull();
  });

  it('a user clear leaves the plugin credential of the same name alone', async () => {
    await userStorage().saveToken('shared', token('user-token'));
    await pluginStorage().saveToken('shared', token('plugin-token'));

    const { service } = setup({ shared: userConfig }, [registration]);
    const result = await service.auth({
      action: 'clear',
      serverId: 'user:shared',
    });

    expect((result as { credentialsDeleted?: boolean }).credentialsDeleted).toBe(
      true,
    );
    expect(await userStorage().getCredentials('shared')).toBeNull();
    expect(
      (await pluginStorage().getCredentials('shared'))?.token.accessToken,
    ).toBe('plugin-token');
  });
});
