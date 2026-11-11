/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createTransport,
  McpAuthorizationRequiredError,
  mcpServerRequiresOAuth,
  type MCPServerConfig,
} from '@qwen-code/core';
import { createGetCommand } from './get.js';
import { mergeSettings, type MergedSettings } from '../../config/settings.js';
const getMcpServersByScope =
  vi.fn<(scope: string) => Record<string, MCPServerConfig>>();
const summarySettings =
  vi.fn<() => { merged: MergedSettings; isTrusted: boolean }>();
import { McpServerEnablementManager } from '../../config/mcp/index.js';

vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  createTransport: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js');
vi.mock('../../config/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/settings.js')>()),
  loadSettings: vi.fn(() => {
    throw new Error('MCP status must use the resolved settings');
  }),
}));
vi.mock('../../config/createCliSettingsService.js', () => ({
  createCliSettingsService: async () => ({
    resolve: () => ({
      ...summarySettings(),
      errors: [],
      ...Object.fromEntries(
        ['user', 'project', 'local'].map((scope) => [
          scope,
          {
            path: '/test/settings.json',
            settings: { mcpServers: getMcpServersByScope(scope) },
          },
        ]),
      ),
    }),
  }),
}));
vi.mock('../../config/mcp/projectMcpJson.js', () => ({
  loadProjectMcpJson: () => ({}),
  getProjectMcpJsonPath: () => '/test/.mcp.json',
}));
vi.mock('../../utils/exitCli.js', () => ({ exitCli: vi.fn() }));

describe('mcp get status through the command entry point', () => {
  let server: MCPServerConfig;
  let output: string[];
  const connect = vi.fn();
  const ping = vi.fn();
  const close = vi.fn();
  const run = (...args: string[]) =>
    createGetCommand().parseAsync(args, { from: 'user' });

  beforeEach(() => {
    vi.resetAllMocks();
    McpServerEnablementManager.resetInstance();
    mcpServerRequiresOAuth.clear();
    output = [];
    server = {
      url: 'https://provider.example/mcp',
      type: 'http',
    };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.mocked(getMcpServersByScope).mockImplementation(
      (scope): Record<string, MCPServerConfig> =>
        scope === 'user' ? { target: server } : {},
    );
    summarySettings.mockReturnValue({
      merged: mergeSettings({}, {}, true),
      isTrusted: true,
    });
    connect.mockImplementation(async () => undefined);
    vi.mocked(Client).mockReturnValue({
      connect,
      ping,
      close,
    } as unknown as Client);
    vi.mocked(createTransport).mockResolvedValue({
      close,
      start: vi.fn(),
      send: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('describes project scope without naming the legacy workspace settings file', async () => {
    vi.mocked(getMcpServersByScope).mockImplementation(
      (scope): Record<string, MCPServerConfig> =>
        scope === 'project' ? { target: server } : {},
    );
    await run('target', '--scope', 'project');
    expect(output.join('')).toContain(
      'Project config (shared in this project)',
    );
    expect(output.join('')).not.toContain('workspace settings.json');
  });



  it('keeps actual Gateway authorization failures distinct from transport failure', async () => {
    connect.mockRejectedValueOnce(
      new McpAuthorizationRequiredError({
        type: 'open_url',
        serverId: 'server',
        connectionId: 'connection',
        authorizationRequestId: 'request',
        url: new URL('https://provider.example/auth?secret=sentinel'),
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    await run('target');
    expect(output.join('')).toContain('Needs authentication');
    expect(output.join('')).not.toContain('secret=sentinel');
    expect(output.join('')).not.toContain('Connection:');
  });





  it('prints only the raw stored config as JSON for --json', async () => {
    await run('target', '--json');
    const serialized = output.join('');
    expect(serialized).toBe(`${JSON.stringify({ target: server }, null, 2)}\n`);
    expect(JSON.parse(serialized)).toEqual({ target: server });
  });




  it('honors merged disablement with normalized names when the selected scope is enabled', async () => {
    server = { command: 'scoped-server' };
    summarySettings.mockReturnValue({
      merged: {
        ...mergeSettings({}, {}, true),
        mcpServers: { TARGET: { command: 'other', disabled: true } },
      },
      isTrusted: true,
    });
    await run('target', '--scope', 'user');
    expect(output.join('')).toContain('Disabled');
    expect(createTransport).not.toHaveBeenCalled();
  });

});
