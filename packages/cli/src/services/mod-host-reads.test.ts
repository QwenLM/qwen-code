/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { LoadedSettings, SettingsFile } from '../config/settings.js';
import { modHostReads } from './mod-host-reads.js';

const file = (settings: Record<string, unknown>) =>
  ({ settings, originalSettings: settings, path: '' }) as SettingsFile;

const loaded = (
  scopes: {
    user?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
    system?: Record<string, unknown>;
    merged?: Record<string, unknown>;
  },
  isTrusted = true,
) =>
  ({
    user: file(scopes.user ?? {}),
    workspace: file(scopes.workspace ?? {}),
    system: file(scopes.system ?? {}),
    systemDefaults: file({}),
    merged: scopes.merged ?? {},
    isTrusted,
    workspaceSettingsActive: true,
  }) as unknown as LoadedSettings;

describe('modHostReads', () => {
  it('reads variables but the credentials and the ones a provider names', () => {
    const reads = modHostReads(
      loaded({
        merged: { modelProviders: { openai: [{ envKey: 'my_llm' }] } },
      }),
      {
        HOME: '/home/someone',
        OPENAI_API_KEY: 'sk-1',
        GITHUB_TOKEN: 'ghp-1',
        MY_LLM: 'secret',
      },
    );
    expect(reads.env('HOME')).toBe('/home/someone');
    expect(reads.env('UNSET')).toBeUndefined();
    expect(reads.env('OPENAI_API_KEY')).toBeUndefined();
    expect(reads.env('GITHUB_TOKEN')).toBeUndefined();
    expect(reads.env('MY_LLM')).toBeUndefined();
  });

  it('gives each source and the merge without credentials', () => {
    const user = {
      general: { vimMode: true },
      security: { auth: { selectedType: 'openai', apiKey: 'sk-1' } },
      env: { OPENAI_API_KEY: 'sk-1', MY_LLM: 'secret', EDITOR: 'vim' },
      modelProviders: { openai: [{ id: 'm', envKey: 'MY_LLM' }] },
      mcpServers: {
        github: {
          command: 'github-mcp',
          env: { GITHUB_PAT: 'pat' },
          headers: { 'X-Team': 'core' },
        },
      },
      model: { sessionTokenLimit: 1000 },
    };
    const { layers, merged } = modHostReads(
      loaded({ user, system: { general: { vimMode: false } }, merged: user }),
      {},
    ).settings();
    const clean = {
      general: { vimMode: true },
      security: { auth: { selectedType: 'openai' } },
      env: { EDITOR: 'vim' },
      modelProviders: { openai: [{ id: 'm', envKey: 'MY_LLM' }] },
      mcpServers: { github: { command: 'github-mcp' } },
      model: { sessionTokenLimit: 1000 },
    };
    expect(merged).toEqual(clean);
    expect(layers).toEqual([
      { source: 'user', settings: clean },
      { source: 'policy', settings: { general: { vimMode: false } } },
    ]);
    // What the session runs under is left as it was.
    expect(user.security.auth.apiKey).toBe('sk-1');
  });

  it('leaves out a string that holds a credential once resolved', () => {
    const resolved = {
      tools: { command: 'curl -H "Bearer ghp-123456"', timeout: 30 },
      mcpServers: { docs: { args: ['--key', 'ghp-123456', '--verbose'] } },
    };
    const { merged } = modHostReads(loaded({ merged: resolved }), {
      GITHUB_TOKEN: 'ghp-123456',
    }).settings();
    expect(merged).toEqual({
      tools: { timeout: 30 },
      mcpServers: { docs: { args: ['--key', '--verbose'] } },
    });
  });

  it('redacts environment and headers in arrays inside MCP server data', () => {
    const mcpServers = {
      docs: {
        command: 'docs-mcp',
        args: ['--verbose'],
        extra: [{ env: { CUSTOM: 'hidden' }, headers: { 'X-Team': 'core' } }],
      },
    };
    const { merged } = modHostReads(
      loaded({ merged: { mcpServers } }),
      {},
    ).settings();

    expect(merged).toEqual({
      mcpServers: {
        docs: {
          command: 'docs-mcp',
          args: ['--verbose'],
          extra: [{}],
        },
      },
    });
  });

  it('hides a variable that only one source names', () => {
    const reads = modHostReads(
      loaded({
        workspace: { modelProviders: { openai: [{ envKey: 'TEAM_LLM' }] } },
      }),
      { TEAM_LLM: 'secret' },
    );
    expect(reads.env('TEAM_LLM')).toBeUndefined();
  });

  it("leaves out an untrusted folder's settings and the empty sources", () => {
    const settings = { workspace: { general: { vimMode: true } } };
    expect(modHostReads(loaded(settings, false), {}).settings().layers).toEqual(
      [],
    );
    expect(modHostReads(loaded(settings), {}).settings().layers).toEqual([
      { source: 'project', settings: { general: { vimMode: true } } },
    ]);
  });
});
