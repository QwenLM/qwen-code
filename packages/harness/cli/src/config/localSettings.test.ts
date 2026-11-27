/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandSettings } from './createCliSettingsService.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistentDisableMcpServer,
  persistentEnableMcpServer,
  removeMcpServer,
  upsertMcpServer,
  type McpScope,
} from './localSettings.js';

const mocks = vi.hoisted(() => ({
  loadProjectMcpJson: vi.fn(),
  writeProjectMcpJson: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    homedir: () => '/home/user',
    sessionLogger: { setExitContext: vi.fn() },
  };
});

vi.mock('./settings.js', () => ({
  SettingScope: {
    User: 'User',
    Project: 'Project',
    Local: 'Local',
  },
}));

vi.mock('./mcp/projectMcpJson.js', () => ({
  loadProjectMcpJson: (...args: unknown[]) =>
    mocks.loadProjectMcpJson(...args),
  writeProjectMcpJson: (...args: unknown[]) =>
    mocks.writeProjectMcpJson(...args),
  getProjectMcpJsonPath: () => '/workspace/.mcp.json',
}));

let settings: CommandSettings;

type ScopeName = 'User' | 'Project' | 'Local';

function configureSettingsScope(
  scope: ScopeName,
  runtimeServers: Record<string, unknown>,
  persistedServers: Record<string, unknown>,
): Record<ScopeName, { settings: Record<string, unknown>; originalSettings: Record<string, unknown>; path: string }> {
  const emptyFile = { settings: {}, originalSettings: {}, path: '' };
  const files: Record<ScopeName, typeof emptyFile> = {
    User: emptyFile,
    Project: emptyFile,
    Local: emptyFile,
  };
  files[scope] = {
    settings: { mcpServers: runtimeServers },
    originalSettings: { mcpServers: persistedServers },
    path: '/settings.json',
  };
  const getPath = (root: Record<string, unknown>, path: string | readonly string[]) => {
    const keys = typeof path === 'string' ? path.split('.') : [...path];
    return keys.reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      root,
    );
  };
  const setPath = (
    root: Record<string, unknown>,
    path: string | readonly string[],
    value: unknown,
  ) => {
    const keys = typeof path === 'string' ? path.split('.') : [...path];
    const last = keys.pop();
    if (!last) return false;
    let current = root;
    for (const key of keys) {
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key] as Record<string, unknown>;
    }
    if (value === undefined) delete current[last];
    else current[last] = value;
    return true;
  };
  const mutateScope = vi.fn(
    (
      requestedScope: ScopeName,
      mutation: (editor: {
        get(path: string | readonly string[]): unknown;
        set(path: string | readonly string[], value: unknown): boolean;
        delete(path: string | readonly string[]): boolean;
      }) => void,
    ) => {
      const root = files[requestedScope].originalSettings;
      mutation({
        get: (path: string | readonly string[]) => getPath(root, path),
        set: (path: string | readonly string[], value: unknown) =>
          setPath(root, path, value),
        delete: (path: string | readonly string[]) =>
          setPath(root, path, undefined),
      });
      return true;
    },
  );
  settings = {
    forScope: (requestedScope: ScopeName) => files[requestedScope],
    mutateScope,
    updateValue: (
      requestedScope: ScopeName,
      path: string | readonly string[],
      updater: (current: unknown) => unknown,
    ) =>
      mutateScope(requestedScope, (editor: {
        get(path: string | readonly string[]): unknown;
        set(path: string | readonly string[], value: unknown): boolean;
      }) => editor.set(path, updater(editor.get(path)))),
  } as unknown as CommandSettings;
  return files;
}

const providerMetadata = {
  hostEndpoint: 'https://mcp.example.com/server',
  type: 'http',
  url: 'https://mcp.example.com',
  oauth: { providerSpecificOption: true },
};

describe('settings-backed MCP writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadProjectMcpJson.mockReturnValue({});
  });

  it.each([true, false])(
    'updates only the original project when enabled=%s',
    async (enabled) => {
      configureSettingsScope('User', {}, {});
      const original = {
        server: { command: 'original-server', disabled: enabled },
      };
      const worktree = {
        server: { command: 'worktree-server', disabled: enabled },
      };
      const projects: Record<string, Record<string, unknown>> = {
        '/original': original,
        '/worktree': worktree,
      };
      mocks.loadProjectMcpJson.mockImplementation((cwd) => projects[cwd] ?? {});
      mocks.writeProjectMcpJson.mockImplementation((cwd, servers) => {
        projects[cwd] = servers;
      });

      if (enabled) {
        await persistentEnableMcpServer('server', '/original', settings);
      } else {
        await persistentDisableMcpServer('server', '/original', settings);
      }

      expect(projects['/original']).toEqual({
        server: {
          command: 'original-server',
          ...(!enabled && { disabled: true }),
        },
      });
      expect(projects['/worktree']).toEqual(worktree);
    },
  );

  it.each([
    ['user', 'User'],
    ['local', 'Local'],
  ] as const)('preserves unknown fields when adding in %s scope', (scope, settingScope) => {
    const files = configureSettingsScope(
      settingScope,
      { existing: { type: 'http', url: 'https://mcp.example.com' } },
      { existing: providerMetadata },
    );

    upsertMcpServer(
      'added',
      { command: 'example' },
      scope as McpScope,
      '/workspace',
      false,
      settings,
    );

    expect(files[settingScope].originalSettings['mcpServers']).toEqual({
      existing: providerMetadata,
      added: { command: 'example' },
    });
  });

  it.each([
    ['user', 'User'],
    ['local', 'Local'],
  ] as const)('preserves unknown fields when removing in %s scope', (scope, settingScope) => {
    const files = configureSettingsScope(
      settingScope,
      {
        keep: { type: 'http', url: 'https://mcp.example.com' },
        remove: { command: 'remove-me' },
      },
      {
        keep: providerMetadata,
        remove: { command: 'remove-me' },
      },
    );

    removeMcpServer('remove', scope as McpScope, '/workspace', settings);

    expect(files[settingScope].originalSettings['mcpServers']).toEqual({
      keep: providerMetadata,
    });
  });

  it('returns a removed settings entry as written', () => {
    configureSettingsScope(
      'User',
      { svc: { url: 'https://mcp.example.com', headers: { 'X-Tenant': 'a' } } },
      { svc: { url: 'https://mcp.example.com', headers: { 'X-Tenant': '$TENANT' } } },
    );

    expect(removeMcpServer('svc', 'user', '/workspace', settings)).toEqual([
      { url: 'https://mcp.example.com', headers: { 'X-Tenant': '$TENANT' } },
    ]);
  });

  it('returns the entry the transaction actually deleted after a concurrent rewrite', () => {
    // Loaded as A; another process has since rewritten it to B, which is
    // what the delete transaction reads and removes.
    const loaded = {
      settings: { mcpServers: { svc: { url: 'https://a.example.com' } } },
      originalSettings: { mcpServers: { svc: { url: 'https://a.example.com' } } },
      path: '',
    };
    const onDisk: Record<string, unknown> = { svc: { url: 'https://b.example.com' } };
    const raced = {
      forScope: () => loaded,
      mutateScope: (
        _scope: unknown,
        mutation: (editor: {
          get(path: readonly string[]): unknown;
          delete(path: readonly string[]): boolean;
        }) => void,
      ) => {
        mutation({
          get: (path) => onDisk[path[1] ?? ''],
          delete: (path) => delete onDisk[path[1] ?? ''],
        });
        return true;
      },
    } as unknown as typeof settings;

    expect(removeMcpServer('svc', 'user', '/workspace', raced)).toEqual([
      { url: 'https://b.example.com' },
    ]);
    expect(onDisk).toEqual({});
  });

  it('keeps the baseline project map write and duplicate check', () => {
    configureSettingsScope('Project', { legacy: { command: 'legacy' } }, {});
    mocks.loadProjectMcpJson.mockReturnValue({
      existing: { command: 'existing' },
    });

    expect(
      upsertMcpServer('existing', { command: 'new' }, 'project', '/workspace', true, settings),
    ).toBe(true);
    expect(mocks.writeProjectMcpJson).not.toHaveBeenCalled();
    expect(
      upsertMcpServer('added', { command: 'added' }, 'project', '/workspace', false, settings),
    ).toBe(false);
    expect(mocks.writeProjectMcpJson).toHaveBeenCalledWith('/workspace', {
      legacy: { command: 'legacy' },
      existing: { command: 'existing' },
      added: { command: 'added' },
    });
  });

  it('removes project and legacy settings entries without reverting the settings transaction', () => {
    const files = configureSettingsScope('Project', {}, {
      remove: { command: 'legacy' },
      keep: { command: 'keep' },
    });
    mocks.loadProjectMcpJson.mockReturnValue({ remove: { command: 'project' } });

    expect(
      removeMcpServer('remove', 'project', '/workspace', settings),
    ).toEqual([{ command: 'project' }, { command: 'legacy' }]);
    expect(mocks.writeProjectMcpJson).toHaveBeenCalledWith('/workspace', {});
    expect(files.Project.originalSettings['mcpServers']).toEqual({
      keep: { command: 'keep' },
    });
  });

  it('preserves unknown fields when persistently disabling', async () => {
    const files = configureSettingsScope(
      'User',
      { existing: { type: 'http', url: 'https://mcp.example.com' } },
      { existing: providerMetadata },
    );

    await persistentDisableMcpServer('existing', process.cwd(), settings);

    expect(files.User.originalSettings['mcpServers']).toEqual({
      existing: { ...providerMetadata, disabled: true },
    });
  });

  it('preserves unknown fields when persistently enabling', async () => {
    const files = configureSettingsScope(
      'User',
      { existing: { type: 'http', url: 'https://mcp.example.com', disabled: true } },
      { existing: { ...providerMetadata, disabled: true } },
    );

    await persistentEnableMcpServer('existing', process.cwd(), settings);

    expect(files.User.originalSettings['mcpServers']).toEqual({
      existing: providerMetadata,
    });
  });
});
