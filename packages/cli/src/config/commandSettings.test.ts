/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage, coreEvents } from '@qwen-code/core';
import * as legacy from '../test-utils/resolveSettings.js';
import {
  createCliSettingsService,
  resolveCommandSettings,
} from './createCliSettingsService.js';
import {
  upsertMcpServer,
  removeMcpServer,
  persistentDisableMcpServer,
} from './localSettings.js';

vi.mock('@qwen-code/core', async (original) => ({
  ...(await original<typeof import('@qwen-code/core')>()),
  isHeadlessMode: () => false,
}));
let root: string;
let user: string;
let project: string;
const argv = process.argv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'command-settings-中文 空格-'));
  user = join(root, 'home', '.qwen');
  project = join(root, 'project');
  mkdirSync(user, { recursive: true });
  mkdirSync(join(project, '.qwen'), { recursive: true });
  vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(user);
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  vi.spyOn(legacy, 'loadSettings').mockImplementation(() => {
    throw new Error('Command must not call legacy loadSettings');
  });
  legacy.setFlagSettingsPath(undefined);
  process.argv = ['node', 'qwen'];
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function write(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data));
}

it('keeps legacy untrusted scope reads while allowing explicit project writes', async () => {
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: true } },
  });
  write(join(project, '.qwen/settings.json'), {
    enabledPlugins: { project: true },
  });
  write(join(project, '.qwen/settings.local.json'), {
    enabledPlugins: { local: true },
  });
  const settings = await resolveCommandSettings(project);
  expect(settings.isTrusted).toBe(false);
  expect(settings.forScope(legacy.SettingScope.Project).settings).toEqual({});
  expect(
    settings.forScope(legacy.SettingScope.Local).settings.enabledPlugins,
  ).toEqual({ local: true });
  expect(settings.merged.enabledPlugins).toEqual({});
  expect(
    settings.setValue(
      legacy.SettingScope.Project,
      ['enabledPlugins', 'written'],
      true,
    ),
  ).toBe(true);
  expect(
    JSON.parse(readFileSync(join(project, '.qwen/settings.json'), 'utf8'))
      .enabledPlugins,
  ).toEqual({ project: true, written: true });
  expect(settings.merged.enabledPlugins).toEqual({});
});

it('passes settings through MCP helpers without falling back to the legacy loader', async () => {
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: false } },
  });
  const settings = await resolveCommandSettings(project);
  expect(
    upsertMcpServer(
      'a.b',
      { command: 'node' },
      'user',
      project,
      false,
      settings,
    ),
  ).toBe(false);
  await persistentDisableMcpServer('a.b', project, settings);
  expect(
    settings.forScope(legacy.SettingScope.User).settings.mcpServers?.['a.b']
      .disabled,
  ).toBe(true);
  expect(
    removeMcpServer('a.b', 'user', project, settings)[0]?.command,
  ).toBe('node');
  expect(settings.merged.mcpServers).toEqual({});
  expect(legacy.loadSettings).not.toHaveBeenCalled();
});

it('retains source filtering for writes and performs deprecated-field migrations', async () => {
  write(join(user, 'settings.json'), { general: { disableAutoUpdate: true } });
  process.argv.push('--setting-sources', 'user');
  const settings = await resolveCommandSettings(project);
  expect(
    JSON.parse(readFileSync(join(user, 'settings.json'), 'utf8')).general,
  ).toEqual({ enableAutoUpdate: false });
  expect(settings.forScope(legacy.SettingScope.Local).readOnly).toBe(true);
  expect(
    settings.setValue(
      legacy.SettingScope.Local,
      ['enabledPlugins', 'memory'],
      true,
    ),
  ).toBe(true);
  expect(legacy.loadSettings).not.toHaveBeenCalled();
});

it('preserves the legacy filesystem error feedback when writing fails', async () => {
  const settings = await resolveCommandSettings(project);
  writeFileSync(join(project, '.qwen/settings.local.json'), '{broken');
  const feedback = vi
    .spyOn(coreEvents, 'emitFeedback')
    .mockImplementation(() => {});
  expect(
    settings.setValue(legacy.SettingScope.Local, 'skills.disabled', ['demo']),
  ).toBe(false);
  expect(feedback).toHaveBeenCalledWith(
    'error',
    'Failed to save settings: Settings file contains invalid JSON. (EINVAL)',
    expect.any(Error),
  );
});

it.each([legacy.SettingScope.User, legacy.SettingScope.Project, legacy.SettingScope.Local] as const)(
  'updates future projections after a Service write to %s',
  async (scope) => {
    vi.mocked(legacy.loadSettings).mockRestore();
    legacy.clearSettingsCache();
    write(join(user, 'settings.json'), {
      security: { folderTrust: { enabled: false } },
    });
    const before = legacy.loadSettings(project);
    const settings = await resolveCommandSettings(project);
    expect(settings.deleteValue(scope, ['enabledPlugins', 'absent'])).toBe(
      true,
    );
    expect(legacy.loadSettings(project)).not.toBe(before);
    expect(settings.setValue(scope, ['enabledPlugins', 'written'], true)).toBe(
      true,
    );
    const after = legacy.loadSettings(project);
    expect(after).not.toBe(before);
    // Every resolution is independent; persisted writes reach future readers.
    expect(settings.forScope(scope).settings.enabledPlugins?.['written']).toBe(true);
    legacy.clearSettingsCache();
  },
);

it('persists project MCP approval decisions through the Service snapshot', async () => {
  const {
    approveProjectMcpServer,
    rejectProjectMcpServer,
    approveAllProjectMcpServers,
    resetProjectMcpChoices,
  } = await import('./mcp/projectMcpApproval.js');
  write(join(user, 'settings.json'), {
    mcp: {
      enabledProjectMcpServers: ['keep'],
      disabledProjectMcpServers: ['SERVER'],
    },
  });
  const settings = await resolveCommandSettings(project);
  expect(approveProjectMcpServer('server', settings)).toBe(true);
  expect(settings.merged.mcp.enabledProjectMcpServers).toEqual([
    'keep',
    'server',
  ]);
  expect(settings.merged.mcp.disabledProjectMcpServers).toEqual([]);
  expect(rejectProjectMcpServer('SERVER', settings)).toBe(true);
  expect(settings.merged.mcp.enabledProjectMcpServers).toEqual(['keep']);
  expect(settings.merged.mcp.disabledProjectMcpServers).toEqual(['SERVER']);
  expect(approveAllProjectMcpServers(settings)).toBe(true);
  expect(settings.merged.mcp.enableAllProjectMcpServers).toBe(true);
  expect(resetProjectMcpChoices(settings)).toBe(true);
  expect(
    JSON.parse(readFileSync(join(user, 'settings.json'), 'utf8')).mcp,
  ).toEqual({
    enabledProjectMcpServers: [],
    disabledProjectMcpServers: [],
    enableAllProjectMcpServers: false,
  });
  expect(legacy.loadSettings).not.toHaveBeenCalled();
});

it('keeps placeholders when project settings are copied into .mcp.json', async () => {
  const secret = 'secret-value-should-stay-out-of-the-file';
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: false } },
  });
  const configDir = new Storage(project).getConfigDir();
  mkdirSync(configDir, { recursive: true });
  write(join(configDir, 'settings.json'), {
    mcpServers: {
      svc: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${CMD_ENV_SECRET}' },
      },
    },
  });
  writeFileSync(join(configDir, '.env'), `CMD_ENV_SECRET=${secret}\n`);
  delete process.env['CMD_ENV_SECRET'];
  try {
    const settings = await resolveCommandSettings(project);
    expect(process.env['CMD_ENV_SECRET']).toBe(secret);
    // Loading .env must not retroactively expand the snapshot copied to disk.
    expect(
      settings.forScope(legacy.SettingScope.Project).settings.mcpServers?.[
        'svc'
      ]?.headers,
    ).toEqual({ Authorization: 'Bearer ${CMD_ENV_SECRET}' });

    upsertMcpServer(
      'added',
      { type: 'http', url: 'https://added.example.com/mcp' },
      'project',
      project,
      false,
      settings,
    );
    const written = readFileSync(join(project, '.mcp.json'), 'utf8');
    expect(written).toContain('Bearer ${CMD_ENV_SECRET}');
    expect(written).not.toContain(secret);
  } finally {
    delete process.env['CMD_ENV_SECRET'];
  }
});

it('does not read the project .env when the project sources are excluded', async () => {
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: false } },
    mcpServers: {
      svc: { type: 'http', url: 'https://$CMD_ENV_TENANT.example.com/mcp' },
    },
  });
  const configDir = new Storage(project).getConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.env'), 'CMD_ENV_TENANT=acme\n');
  delete process.env['CMD_ENV_TENANT'];
  process.argv.push('--setting-sources', 'user');
  try {
    const settings = await resolveCommandSettings(project);
    expect(process.env['CMD_ENV_TENANT']).toBeUndefined();
    expect(
      settings.forScope(legacy.SettingScope.User).settings.mcpServers?.['svc']
        ?.url,
    ).toBe('https://$CMD_ENV_TENANT.example.com/mcp');
  } finally {
    delete process.env['CMD_ENV_TENANT'];
  }
});

it('does not read an untrusted project .env', async () => {
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: true } },
  });
  const configDir = new Storage(project).getConfigDir();
  mkdirSync(configDir, { recursive: true });
  write(join(configDir, 'settings.json'), {});
  writeFileSync(join(configDir, '.env'), 'CMD_ENV_TRUST=acme\n');
  delete process.env['CMD_ENV_TRUST'];
  try {
    const settings = await resolveCommandSettings(project);
    expect(settings.isTrusted).toBe(false);
    expect(process.env['CMD_ENV_TRUST']).toBeUndefined();
  } finally {
    delete process.env['CMD_ENV_TRUST'];
  }
});

it('keeps project MCP approvals across a restart', async () => {
  const { getPendingProjectMcpServers } = await import('./config.js');
  const { approveAllProjectMcpServers } = await import(
    './mcp/projectMcpApproval.js'
  );
  write(join(user, 'settings.json'), {
    security: { folderTrust: { enabled: true } },
  });
  write(join(project, '.mcp.json'), {
    mcpServers: {
      alpha: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      beta: { command: 'node', args: ['-e', ''] },
    },
  });

  // Same projection the app passes around; resolveCommandSettings narrows the
  // same resolved object to CommandSettings, which the pending check cannot use.
  const resolveLoaded = () =>
    createCliSettingsService({ hideUntrustedProject: true }).resolve({
      projectPath: project,
    });

  const first = resolveLoaded();
  expect(
    Object.keys(getPendingProjectMcpServers(first, project)).sort(),
  ).toEqual(['alpha', 'beta']);
  expect(approveAllProjectMcpServers(first)).toBe(true);

  // A restart resolves a fresh settings projection from the same files.
  const second = resolveLoaded();
  expect(getPendingProjectMcpServers(second, project)).toEqual({});
});
