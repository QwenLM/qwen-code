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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SettingsService,
  invalidateSettingsFileSources,
  invalidateUserSettingsSources,
  type SettingsValues,
  type SettingsSource,
  type SettingsRuntimeContext,
} from '../index.js';

const roots: string[] = [];
function fixture(context: SettingsRuntimeContext = {}) {
  const root = mkdtempSync(join(tmpdir(), 'settings-中文 空格-'));
  roots.push(root);
  const userConfigDir = join(root, 'user-config');
  const projectPath = join(root, 'project');
  mkdirSync(userConfigDir);
  mkdirSync(join(projectPath, '.qwen'), { recursive: true });
  const userFile = join(userConfigDir, 'settings.json');
  const projectFile = join(projectPath, '.qwen', 'settings.json');
  const localFile = join(projectPath, '.qwen', 'settings.local.json');
  return {
    root,
    userConfigDir,
    projectPath,
    userFile,
    projectFile,
    localFile,
    service: new SettingsService(undefined, context),
  };
}
function write(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('strict reload preserves every layer on a rejected read and can retry', async () => {
  const { service, userConfigDir, userFile, projectFile, projectPath } = fixture();
  write(userFile, { model: { name: 'old-user' } });
  write(projectFile, { model: { name: 'old-project' } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({
    projectPath,
    flagSettings: { model: { name: 'flag-model' } },
  });
  const before = settings.getSnapshot();
  const changed = vi.fn();
  settings.subscribe(changed);
  try {
    write(userFile, { model: { name: 'new-user' } });
    writeFileSync(projectFile, '{ invalid JSON');
    expect(() => settings.reload({ rejectInvalid: true })).toThrow(
      'Failed to reload settings',
    );
    expect(settings.getSnapshot()).toBe(before);
    expect(settings.user.settings.model?.name).toBe('old-user');
    expect(changed).not.toHaveBeenCalled();

    write(projectFile, {});
    settings.reload({ rejectInvalid: true });
    expect(settings.user.settings.model?.name).toBe('new-user');
    expect(settings.merged.model?.name).toBe('flag-model');
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    await service.dispose();
  }
});

it('binds raw sources before initialization without initializing resolve', async () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  expect(service.peekUserSettingsSource()).toBeUndefined();
  expect(service.peekUserSettingsSource(userFile)).toBeUndefined();
  const user = service.getUserSettingsSource(userFile);
  expect(service.peekUserSettingsSource()).toBe(user);
  expect(service.peekUserSettingsSource(userFile)).toBe(user);
  expect(
    service.peekUserSettingsSource(join(projectPath, 'other.json')),
  ).toBeUndefined();
  expect(() => service.resolve({ projectPath })).toThrow('not initialized');
  const read = vi.spyOn(user, 'read');
  try {
    write(userFile, { label: 'initial' });
    service.initialize({ userConfigDir });
    expect(read).toHaveBeenCalledOnce();
    user.invalidate();
    service.initialize({ userConfigDir });
    expect(read).toHaveBeenCalledOnce();
    expect(() =>
      service.initialize({ userConfigDir, projectConfigDirName: '.other' }),
    ).toThrow('already fixed');
    expect(
      (
        service.resolve({ projectPath }).user.settings as Record<
          string,
          unknown
        >
      )['label']).toBe(
      'initial',
    );
  } finally {
    read.mockRestore();
    await service.dispose();
  }
});

it('only attaches caller-owned user settings when their root is compatible', async () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  const incompatible = join(projectPath, 'user-settings.json');
  const user = service.getCompatibleUserSettingsSource(userFile);
  expect(user).toBe(service.getUserSettingsSource(userFile));
  expect(service.getCompatibleUserSettingsSource(incompatible)).toBeUndefined();
  expect(() => service.getUserSettingsSource(incompatible)).toThrow(
    'already fixed',
  );
  expect(() => service.initialize({ userConfigDir: projectPath })).toThrow(
    'already fixed',
  );
  service.initialize({ userConfigDir });
  expect(service.peekUserSettingsSource()).toBe(user);
  await service.dispose();
});

it('reuses project/local pairs by actual file paths independently of resolve policy', async () => {
  const {
    service,
    userConfigDir,
    userFile,
    projectPath,
    projectFile,
    localFile,
    root,
  } = fixture();
  const first = service.getProjectSettingsSources(projectFile, localFile);
  const same = service.getProjectSettingsSources(
    join(projectPath, '.qwen', '.', 'settings.json'),
    localFile,
  );
  const other = service.getProjectSettingsSources(
    join(root, 'other', 'settings.json'),
    join(root, 'other', 'settings.local.json'),
  );
  expect(same).toBe(first);
  expect(other.project).not.toBe(first.project);
  expect(other.local).not.toBe(first.local);
  expect(
    service.getProjectSettingsSources(projectFile, other.local.path),
  ).not.toBe(first);
  expect(first.project).not.toBe(service.getUserSettingsSource(userFile));
  service.initialize({ userConfigDir });
  service.resolve({
    projectPath,
    sources: ['project'],
    flagSettings: { custom: true },
  });
  service.resolve({ projectPath, sources: ['local'] });
  expect(service.getProjectSettingsSources(projectFile, localFile)).toBe(first);
  await service.dispose();
  expect(() =>
    service.getProjectSettingsSources(projectFile, localFile),
  ).toThrow('disposed');
});

it('does not acquire project sources for user-only or excluded disk scopes', () => {
  const { service, userConfigDir, projectPath } = fixture();
  service.initialize({ userConfigDir });
  const getProject = vi.spyOn(service, 'getProjectSettingsSources');
  service.resolve({ projectPath, sources: ['user'] });
  service.resolve({ projectPath, sources: [] });
  expect(getProject).not.toHaveBeenCalled();
  service.resolve({ projectPath, sources: ['local'] });
  expect(getProject).toHaveBeenCalledOnce();
});

it.each(['project', 'local'] as const)(
  'invalidates the shared %s source before every enabled resolve read',
  async (scope) => {
    const { service, userConfigDir, projectPath, projectFile, localFile } =
      fixture();
    const sources = service.getProjectSettingsSources(projectFile, localFile);
    const source = sources[scope];
    write(source.path, { label: 'initial' });
    service.initialize({ userConfigDir });
    const read = vi.spyOn(source, 'read');
    const invalidate = vi.spyOn(source, 'invalidate');
    try {
      const initial = service.resolve({ projectPath, sources: [scope] });
      expect(
        (initial[scope].settings as Record<string, unknown>)['label']).toBe('initial');
      expect(read).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
        read.mock.invocationCallOrder[0],
      );
      write(source.path, { label: 'external' });
      const changed = service.resolve({ projectPath, sources: [scope] });
      expect(
        (changed[scope].settings as Record<string, unknown>)['label']).toBe('external');
      expect(
        (initial[scope].settings as Record<string, unknown>)['label']).toBe('initial');
      expect(read).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledTimes(2);
      service.resolve({ projectPath, sources: [] });
      expect(read).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      invalidate.mockRestore();
      await service.dispose();
    }
  },
);

it.each(['all', 'file', 'user', 'source'] as const)(
  'rereads externally invalidated user settings via %s without changing old snapshots',
  (invalidation) => {
    const { service, userConfigDir, userFile, projectPath } = fixture();
    write(userFile, { enabledPlugins: { original: true } });
    service.initialize({ userConfigDir });
    const original = service.resolve({ projectPath });
    write(userFile, { enabledPlugins: { external: true } });
    if (invalidation === 'all') service.invalidateAll();
    else if (invalidation === 'file') invalidateSettingsFileSources(userFile);
    else if (invalidation === 'user') invalidateUserSettingsSources(userFile);
    else service.peekUserSettingsSource()!.invalidate();
    expect(
      service.resolve({ projectPath }).user.settings.enabledPlugins,
    ).toEqual({ external: true });
    expect(original.user.settings.enabledPlugins).toEqual({ original: true });
    expect(original.merged.enabledPlugins).toEqual({ original: true });
  },
);

it('uses the shared user source TTL and recovers from externally invalidated malformed text', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  write(userFile, { label: 'initial' });
  service.initialize({ userConfigDir });
  writeFileSync(userFile, '{broken');
  expect(
    (service.resolve({ projectPath }).user.settings as Record<string, unknown>)['label']).toBe(
    'initial',
  );
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
  try {
    expect(service.resolve({ projectPath }).errors).toHaveLength(1);
    write(userFile, { label: 'recovered' });
    service.invalidateAll();
    const recovered = service.resolve({ projectPath });
    expect(recovered.errors).toEqual([]);
    expect((recovered.user.settings as Record<string, unknown>)['label']).toBe('recovered');
  } finally {
    now.mockRestore();
  }
});

it('shares raw writes but not trust, flags, environment or parsed state between services', async () => {
  const { service, userConfigDir, userFile, projectPath, projectFile } =
    fixture({
      headless: false,
      environment: { TOKEN: 'first' },
    });
  const other = new SettingsService(undefined, {
    headless: true,
    environment: { TOKEN: 'second' },
  });
  write(userFile, {
    custom: '${TOKEN}',
    security: { folderTrust: { enabled: true } },
  });
  write(projectFile, { projectOnly: true });
  service.initialize({ userConfigDir });
  other.initialize({ userConfigDir });
  try {
    const first = service.resolve({
      projectPath,
      flagSettings: { flag: 'first' },
    });
    const second = other.resolve({ projectPath });
    expect(service.peekUserSettingsSource()).not.toBe(
      other.peekUserSettingsSource(),
    );
    expect(first.isTrusted).toBe(false);
    expect(second.isTrusted).toBe(true);
    expect(
      (first.merged as Record<string, unknown>)['projectOnly']).toBeUndefined();
    expect((second.merged as Record<string, unknown>)['projectOnly']).toBe(true);
    expect((first.user.settings as Record<string, unknown>)['custom']).toBe('first');
    expect((second.user.settings as Record<string, unknown>)['custom']).toBe('second');
    expect((second.merged as Record<string, unknown>)['flag']).toBeUndefined();
    expect(first.setValue('user', 'written', true)).toBe(true);
    expect(
      (second.user.settings as Record<string, unknown>)['written']).toBeUndefined();
    expect(
      (other.resolve({ projectPath }).user.settings as Record<string, unknown>)['written']).toBe(true);
  } finally {
    await service.dispose();
    await other.dispose();
  }
});

it.each(['requestDispose', 'dispose'] as const)(
  'rejects new access after %s but preserves returned snapshots and writes',
  async (method) => {
    const {
      service,
      userConfigDir,
      userFile,
      projectPath,
      projectFile,
      localFile,
    } = fixture();
    service.initialize({ userConfigDir });
    const settings = service.resolve({ projectPath });
    const source = service.peekUserSettingsSource()!;
    const disposal = service[method]();
    expect(disposal).toBeInstanceOf(Promise);
    await disposal;
    expect(() => service.resolve({ projectPath })).toThrow('disposed');
    expect(() => service.getUserSettingsSource(userFile)).toThrow('disposed');
    expect(() => service.getCompatibleUserSettingsSource(userFile)).toThrow(
      'disposed',
    );
    expect(() => service.peekUserSettingsSource()).toThrow('disposed');
    expect(() =>
      service.getProjectSettingsSources(projectFile, localFile),
    ).toThrow('disposed');
    expect(() => service.watchFiles([], vi.fn())).toThrow('disposed');
    // Cache registries may still hold a WeakRef to a disposed, live service.
    expect(() => service.invalidateAll()).not.toThrow();
    expect(() => service.invalidateAll()).not.toThrow();
    expect(settings.setValue('user', 'afterDispose', true)).toBe(true);
    expect(
      (settings.user.settings as Record<string, unknown>)['afterDispose']).toBe(true);
    expect(JSON.parse(source.read()!)['afterDispose']).toBe(true);
    await service.dispose();
  },
);

it('holds the shared user text within its TTL but rereads each project independently', () => {
  const { service, userConfigDir, userFile, projectPath, projectFile, root } =
    fixture();
  write(userFile, { enabledPlugins: { user: true } });
  service.initialize({ userConfigDir });
  write(userFile, { enabledPlugins: { changed: true } });
  service.initialize({ userConfigDir });
  const first = service.resolve({ projectPath });
  write(projectFile, { enabledPlugins: { project: true } });
  const second = service.resolve({ projectPath });
  expect(first.user.path).toBe(userFile);
  expect(first.merged.enabledPlugins).toEqual({ user: true });
  expect(second.merged.enabledPlugins).toEqual({ user: true, project: true });
  expect(
    service.resolve({ projectPath: join(root, 'other') }).merged.enabledPlugins,
  ).toEqual({ user: true });
  expect(() =>
    service.initialize({ userConfigDir: join(root, 'different-user') }),
  ).toThrow('already fixed');
});

it('merges user < project < local < flag and filters file sources', () => {
  const {
    service,
    userConfigDir,
    projectPath,
    userFile,
    projectFile,
    localFile,
  } = fixture();
  write(userFile, { label: 'user', nested: { a: 1 }, list: [1] });
  write(projectFile, { label: 'project', nested: { b: 2 }, list: [2] });
  write(localFile, { label: 'local' });
  service.initialize({ userConfigDir });
  const loaded = service.resolve({
    projectPath,
    flagSettings: { label: 'flag' },
  });
  expect((loaded.merged as Record<string, unknown>)['label']).toBe('flag');
  expect((loaded.merged as Record<string, unknown>)['nested']).toEqual({ a: 1, b: 2 });
  expect((loaded.merged as Record<string, unknown>)['list']).toEqual([2]);
  expect([
    (loaded.user.settings as Record<string, unknown>)['label'],
    (loaded.project.settings as Record<string, unknown>)['label'],
    (loaded.local.settings as Record<string, unknown>)['label'],
  ]).toEqual(['user', 'project', 'local']);
  expect(
    (service.resolve({ projectPath }).merged as Record<string, unknown>)['label']).toBe('local');
  expect(
    (
      service.resolve({ projectPath, sources: ['user', 'project'] }).merged as Record<string, unknown>
    )[
      'label'
    ],
  ).toBe('project');
  expect(
    (
      service.resolve({ projectPath, sources: ['user'] }).merged as Record<
        string,
        unknown
      >
    )['label'],
  ).toBe('user');
  expect(
    (
      service.resolve({ projectPath, sources: [] }).merged as Record<
        string,
        unknown
      >
    )['label'],
  ).toBeUndefined();
  expect(
    (
      service.resolve({
      projectPath,
      sources: [],
      flagSettings: { label: 'flag' },
    }).merged as Record<string, unknown>
    )['label'],
  ).toBe('flag');
  expect(
    (
    service.resolve({
      projectPath,
      sources: ['unknown' as SettingsSource, 'user'],
    }).merged as Record<string, unknown>
    )['label'],
  ).toBe('user');
});

it('keeps command map overrides atomic and unions only supported command lists', () => {
  const { service, userConfigDir, projectPath, userFile, projectFile } =
    fixture();
  write(userFile, {
    mcpServers: { server: { command: 'node', args: ['old'] } },
    blockedMarketplaces: ['one'],
    skills: { disabled: ['a'] },
    mcp: { allowed: ['a'], enabledProjectMcpServers: ['a'] },
    extraKnownMarketplaces: { one: { source: 'old', type: 'git', ref: 'old' } },
  });
  write(projectFile, {
    mcpServers: { server: { command: 'python' } },
    blockedMarketplaces: ['one', 'two'],
    skills: { disabled: ['a', 'b'] },
    mcp: { allowed: ['b'], enabledProjectMcpServers: ['b'] },
    extraKnownMarketplaces: { one: { source: 'new', type: 'local' } },
  });
  service.initialize({ userConfigDir });
  const { merged } = service.resolve({ projectPath });
  expect(merged.mcpServers?.['server']).toEqual({ command: 'python' });
  expect(merged.extraKnownMarketplaces?.['one']).toEqual({
    source: 'new',
    type: 'local',
  });
  expect(merged.skills?.disabled).toEqual(['a', 'b']);
  expect(merged.blockedMarketplaces).toEqual(['one', 'two']);
  expect(merged.mcp?.enabledProjectMcpServers).toEqual(['a', 'b']);
  expect(merged.mcp?.allowed).toEqual(['b']);
});

it('isolates defaults, input overrides, file layers and merged output', () => {
  const { service, userConfigDir, projectPath, userFile } = fixture();
  write(userFile, { enabledPlugins: { one: true } });
  service.initialize({ userConfigDir });
  const flagSettings: SettingsValues = { skills: { disabled: ['a'] } };
  const a = service.resolve({ projectPath, flagSettings });
  a.merged.skills!.disabled!.push('private');
  a.merged.enabledPlugins!['one'] = false;
  a.flag.settings.skills!.disabled!.push('flag-private');
  expect(flagSettings.skills?.disabled).toEqual(['a']);
  expect(a.user.settings.enabledPlugins?.['one']).toBe(true);
  expect(service.resolve({ projectPath }).merged.skills?.disabled).toEqual([]);
  expect(service.resolve({ projectPath }).merged.enabledPlugins?.['one']).toBe(
    true,
  );
});

it('reports invalid files, skips disabled files and rejects invalid explicit overrides', () => {
  const { service, userConfigDir, projectPath, userFile, projectFile } =
    fixture();
  writeFileSync(userFile, '{broken');
  write(projectFile, []);
  service.initialize({ userConfigDir });
  expect(service.resolve({ projectPath }).errors.map((e) => e.path)).toEqual([
    userFile,
    projectFile,
  ]);
  expect(service.resolve({ projectPath, sources: [] }).errors).toEqual([]);
  for (const value of [null, [], 42]) {
    expect(() =>
      service.resolve({
        projectPath,
        flagSettings: value as unknown as SettingsValues,
      }),
    ).toThrow('JSON object');
  }
});

it('reads BOM/JSONC, normalizes legacy values and expands env without writes', () => {
  const { service, userConfigDir, projectPath, userFile } = fixture();
  const text =
    '\uFEFF{ // comment\n"model":"auto","custom":{"text":"${HOME}"},"ui":{"theme":"VS"}}';
  writeFileSync(userFile, text);
  service.initialize({ userConfigDir });
  const result = service.resolve({ projectPath });
  expect(result.merged['model']).toEqual({ name: 'auto' });
  expect((result.merged as Record<string, unknown>)['custom']).toEqual({
    text: process.env['HOME'] ?? '${HOME}',
  });
  expect(result.merged['ui']).toEqual({ theme: 'VS' });
  expect(readFileSync(userFile, 'utf8')).toBe(text);
});

it('treats missing directories as empty and enforces initialization/disposal', () => {
  const { service, root, projectPath } = fixture();
  expect(() => service.resolve({ projectPath })).toThrow('not initialized');
  service.initialize({ userConfigDir: join(root, 'missing') });
  const result = service.resolve({ projectPath });
  expect(result.errors).toEqual([]);
  expect(result.user.settings).toEqual({});
  expect(result.merged.skills?.enabled).toBe(true);
  expect(result.merged['model']).toBeUndefined();
  service.dispose();
  service.dispose();
  expect(() => service.initialize({ userConfigDir: root })).toThrow('disposed');
  expect(() => service.resolve({ projectPath })).toThrow('disposed');
  expect(result.merged.skills?.enabled).toBe(true);
});

it('does not read the user config directory again as project/local', () => {
  const { service, projectPath, projectFile, localFile } = fixture();
  write(projectFile, { label: 'user' });
  write(localFile, { label: 'not-project' });
  service.initialize({ userConfigDir: join(projectPath, '.qwen') });
  expect(
    (service.resolve({ projectPath }).merged as Record<string, unknown>)['label']).toBe('user');
  const result = service.resolve({
    projectPath,
    sources: ['project', 'local'],
  });
  expect(result.project.settings).toEqual({});
  expect(result.local.settings).toEqual({});
});

it('does not merge prototype keys, including map entry names', () => {
  const { service, userConfigDir, projectPath, userFile } = fixture();
  writeFileSync(
    userFile,
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"mcpServers":{"__proto__":{"polluted":true},"ok":{"command":"node"}}}',
  );
  service.initialize({ userConfigDir });
  const { merged } = service.resolve({ projectPath });
  expect(Object.hasOwn(merged, '__proto__')).toBe(false);
  expect(Object.hasOwn(merged, 'constructor')).toBe(false);
  expect(Object.hasOwn(merged.mcpServers!, '__proto__')).toBe(false);
  expect(Object.prototype).not.toHaveProperty('polluted');
  expect(merged.mcpServers?.['ok']).toEqual({ command: 'node' });
});

it('derives project/local paths from the configured directory without falling back to .qwen', () => {
  const { service, userConfigDir, projectPath, projectFile, localFile } =
    fixture();
  write(projectFile, { label: 'old-project' });
  write(localFile, { label: 'old-local' });
  const selected = join(projectPath, '配置 custom');
  mkdirSync(selected);
  const projectSettingsPath = join(selected, 'settings.json');
  const localSettingsPath = join(selected, 'settings.local.json');
  write(projectSettingsPath, { label: 'selected-project' });
  write(localSettingsPath, { label: 'selected-local' });
  service.initialize({ userConfigDir, projectConfigDirName: '配置 custom' });
  expect(() =>
    service.initialize({ userConfigDir, projectConfigDirName: '.qwen' }),
  ).toThrow('already fixed');
  const options = { projectPath };
  const loaded = service.resolve(options);
  expect(loaded.project.path).toBe(projectSettingsPath);
  expect(loaded.local.path).toBe(localSettingsPath);
  expect((loaded.merged as Record<string, unknown>)['label']).toBe('selected-local');
  expect(
    (
    service.resolve({ ...options, sources: ['project'] }).merged as Record<
        string,
        unknown
      >
    )['label'],
  ).toBe('selected-project');
  rmSync(projectSettingsPath);
  rmSync(localSettingsPath);
  const missing = service.resolve(options);
  expect(missing.project.settings).toEqual({});
  expect(missing.local.settings).toEqual({});
  expect(missing.errors).toEqual([]);
  expect((missing.merged as Record<string, unknown>)['label']).toBeUndefined();
});

it('uses the supplied schema for validation, recovery, defaults and merge rules', async () => {
  const { z } = await import('zod');
  const { userConfigDir, projectPath, userFile, projectFile } = fixture();
  const service = new SettingsService({
    validation: z
      .object({
        mcpServers: z
          .record(
            z.object({
              command: z.string().optional(),
              disabled: z.boolean().optional(),
            }),
          )
          .optional(),
        tags: z.array(z.string()).optional(),
      })
      .passthrough(),
    schema: {
      mcpServers: { default: {}, mergeStrategy: 'shallow_merge' },
      tags: { default: ['default'], mergeStrategy: 'union' },
    },
  });
  write(userFile, {
    mcpServers: { valid: { command: 'user', foreign: 'remove' }, bad: 42 },
    tags: ['user'],
  });
  write(projectFile, {
    mcpServers: { valid: { command: 'project' } },
    tags: ['project'],
  });
  service.initialize({ userConfigDir });
  const loaded = service.resolve({ projectPath });
  expect(loaded.merged.mcpServers).toEqual({ valid: { command: 'project' } });
  expect((loaded.merged as Record<string, unknown>)['tags']).toEqual(['default', 'user', 'project']);
  expect(loaded.user.settings.mcpServers).toEqual({
    valid: { command: 'user' },
  });
  expect(loaded.errors.some((error) => error.message.includes('bad'))).toBe(
    true,
  );
});

it('derives project trust only from user settings and applies flags regardless of trust', () => {
  const { service, userConfigDir, projectPath, projectFile, userFile } =
    fixture({ headless: false });
  write(userFile, { mcpServers: { user: { command: 'user' } } });
  write(projectFile, {
    security: { folderTrust: { enabled: false } },
    mcpServers: { project: { command: 'project' } },
  });
  service.initialize({ userConfigDir });
  const loaded = service.resolve({
    projectPath,
    flagSettings: { mcpServers: { flag: { command: 'flag' } } },
  });
  expect(loaded.isTrusted).toBe(false);
  expect(Object.keys(loaded.merged.mcpServers!)).toEqual(['user', 'flag']);
  const headlessService = new SettingsService(undefined, { headless: true });
  headlessService.initialize({ userConfigDir });
  expect(headlessService.resolve({ projectPath }).isTrusted).toBe(true);
  expect(service.resolve({ projectPath }).isTrusted).toBe(false);
});

it('loads explicit flags even with no file sources and rejects missing or malformed flag files', () => {
  const { service, userConfigDir, projectPath, root } = fixture();
  const flag = join(root, 'flags.json');
  service.initialize({ userConfigDir });
  expect(() => service.resolve({ projectPath, flagSettings: flag })).toThrow(
    'not found',
  );
  writeFileSync(flag, '{bad');
  expect(() => service.resolve({ projectPath, flagSettings: flag })).toThrow();
  write(flag, { mcpServers: { flag: { command: 'flag' } } });
  expect(
    service.resolve({
      projectPath,
      sources: [],
      flagSettings: relative(projectPath, flag),
    }).flag.path,
  ).toBe(flag);
  expect(
    service.resolve({ projectPath, sources: [], flagSettings: flag }).merged
      .mcpServers,
  ).toEqual({ flag: { command: 'flag' } });
});

it('keeps env expansion order, defers hooks and preserves host values', () => {
  const environment: NodeJS.ProcessEnv = {};
  const { service, userConfigDir, projectPath, userFile } = fixture({
    headless: false,
    environment,
  });
  write(userFile, {
    permissions: { trustDirectories: [projectPath] },
    custom: '${SERVICE_VALUE}',
    hooks: { custom: '${SERVICE_VALUE}' },
  });
  writeFileSync(
    join(projectPath, '.qwen', '.env'),
    'SERVICE_VALUE=project\nQWEN_INTEGRATION_ID=unsafe\n',
  );
  writeFileSync(join(userConfigDir, '.env'), 'GLOBAL_ONLY=yes\n');
  service.initialize({ userConfigDir });
  const loaded = service.resolve({ projectPath });
  expect((loaded.merged as Record<string, unknown>)['custom']).toBe('${SERVICE_VALUE}');
  expect(loaded.merged['hooks']).toEqual({ custom: '${SERVICE_VALUE}' });
  expect(environment).toEqual({ SERVICE_VALUE: 'project' });
  environment['SERVICE_VALUE'] = 'host';
  expect(
    (service.resolve({ projectPath }).merged as Record<string, unknown>)['custom']).toBe('host');
});

it('excludes HOME project layers through symlinks while retaining nested projects and explicit flags', () => {
  const { root, userConfigDir, projectPath, userFile, projectFile, localFile } =
    fixture();
  write(userFile, { label: 'user' });
  write(projectFile, { label: 'project' });
  write(localFile, { label: 'local' });
  const service = new SettingsService(undefined, {
    homeDir: projectPath,
    headless: true,
  });
  service.initialize({ userConfigDir });
  expect(
    (service.resolve({ projectPath }).merged as Record<string, unknown>)['label']).toBe('user');
  const alias = join(root, 'home-link');
  symlinkSync(projectPath, alias, 'junction');
  expect(
    (service.resolve({ projectPath: alias }).merged as Record<string, unknown>)['label']).toBe('user');
  expect(
    (
      service.resolve({ projectPath: alias, sources: ['project', 'local'] })
      .merged as Record<string, unknown>
    )['label'],
  ).toBeUndefined();
  expect(
    (
      service.resolve({ projectPath: alias, flagSettings: { label: 'flag' } })
      .merged as Record<string, unknown>
    )['label'],
  ).toBe('flag');
  const nested = join(projectPath, 'nested');
  mkdirSync(join(nested, '.qwen'), { recursive: true });
  write(join(nested, '.qwen', 'settings.json'), { label: 'nested' });
  expect(
    (
      service.resolve({ projectPath: nested }).merged as Record<string, unknown>
    )['label']).toBe(
    'nested',
  );
});

it.each([
  { sources: ['user'], trusted: true, home: false, projectEnv: false },
  { sources: [], trusted: true, home: false, projectEnv: false },
  { sources: ['project'], trusted: true, home: false, projectEnv: true },
  { sources: ['local'], trusted: true, home: false, projectEnv: true },
  { sources: undefined, trusted: false, home: false, projectEnv: false },
  { sources: undefined, trusted: true, home: true, projectEnv: false },
] as const)(
  'gates project env by sources, trust and HOME: %j',
  ({ sources, trusted, home, projectEnv }) => {
    const { userConfigDir, projectPath, userFile } = fixture();
    const environment: NodeJS.ProcessEnv = { HOST_VALUE: 'host' };
    write(
      userFile,
      trusted ? { permissions: { trustDirectories: [projectPath] } } : {},
    );
    writeFileSync(
      join(userConfigDir, '.env'),
      'ENV_ORIGIN=user\nHOST_VALUE=user\n',
    );
    writeFileSync(
      join(projectPath, '.qwen', '.env'),
      'ENV_ORIGIN=project\nNODE_OPTIONS=--require=./payload.cjs\nPROJECT_ONLY=yes\nHOST_VALUE=project\n',
    );
    const service = new SettingsService(undefined, {
      headless: trusted,
      environment,
      homeDir: home ? projectPath : undefined,
    });
    service.initialize({ userConfigDir });
    service.resolve({
      projectPath,
      sources,
      // A flag must not grant env trust to an otherwise untrusted project.
      flagSettings: { security: { folderTrust: { enabled: false } } },
    });
    expect(environment).toEqual(
      projectEnv
        ? {
            HOST_VALUE: 'host',
            ENV_ORIGIN: 'project',
            NODE_OPTIONS: '--require=./payload.cjs',
            PROJECT_ONLY: 'yes',
          }
        : { HOST_VALUE: 'host', ENV_ORIGIN: 'user' },
    );
  },
);

it('reads scoped files from an independent snapshot, including legacy scope names', () => {
  const {
    service,
    userConfigDir,
    projectPath,
    userFile,
    projectFile,
    localFile,
  } = fixture();
  write(userFile, { enabledPlugins: { demo: true } });
  write(projectFile, { enabledPlugins: { demo: false } });
  write(localFile, { enabledPlugins: { local: true } });
  service.initialize({ userConfigDir });
  const loaded = service.resolve({ projectPath });
  for (const scope of ['user', 'project', 'local'] as const) {
    expect(loaded.forScope(scope)).toBe(loaded[scope]);
  }
  expect(loaded.forScope('User')).toBe(loaded.user);
  expect(loaded.forScope('Project').settings.enabledPlugins).toEqual({
    demo: false,
  });
  expect(loaded.forScope('Local')).toBe(loaded.local);
  const filtered = service.resolve({ projectPath, sources: ['user'] });
  expect(filtered.forScope('project').settings).toEqual({});
  write(projectFile, { enabledPlugins: { changed: true } });
  service.dispose();
  expect(loaded.forScope('project').settings.enabledPlugins).toEqual({
    demo: false,
  });
  expect(() => loaded.forScope('Session' as 'user')).toThrow('Invalid scope');
});

it('writes one scope, refreshes the user cache, and isolates existing snapshots', () => {
  const { service, userConfigDir, userFile, projectPath, projectFile } =
    fixture();
  write(userFile, { enabledPlugins: { user: true } });
  write(projectFile, { enabledPlugins: { project: true } });
  service.initialize({ userConfigDir });
  const first = service.resolve({ projectPath });
  const isolated = service.resolve({ projectPath });
  expect(first.setValue('User', ['enabledPlugins', 'new.plugin'], true)).toBe(
    true,
  );
  expect(JSON.parse(readFileSync(userFile, 'utf8')).enabledPlugins).toEqual({
    user: true,
    'new.plugin': true,
  });
  expect(JSON.parse(readFileSync(projectFile, 'utf8')).enabledPlugins).toEqual({
    project: true,
  });
  expect(first.merged.enabledPlugins?.['new.plugin']).toBe(true);
  expect(isolated.merged.enabledPlugins?.['new.plugin']).toBeUndefined();
  expect(
    service.resolve({ projectPath }).merged.enabledPlugins?.['new.plugin'],
  ).toBe(true);
});

it('rereads during mutation without losing comments or unrelated external edits', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  write(userFile, { enabledPlugins: { old: true } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  writeFileSync(
    userFile,
    '\uFEFF{\n // keep comment\n "enabledPlugins": {"old": true, "external": true}\n}\n',
  );
  expect(
    settings.mutateScope('user', (editor) => {
      expect(editor.get(['enabledPlugins', 'external'])).toBe(true);
      editor.delete(['enabledPlugins', 'old']);
      editor.set(['enabledPlugins', 'new'], true);
    }),
  ).toBe(true);
  expect(readFileSync(userFile, 'utf8')).toContain('keep comment');
  expect(settings.user.originalSettings.enabledPlugins).toEqual({
    external: true,
    new: true,
  });
  expect(settings.merged.enabledPlugins).toEqual({ new: true });
  expect(service.resolve({ projectPath }).merged.enabledPlugins).toEqual({
    external: true,
    new: true,
  });
});

it('keeps excluded-source mutations in memory while flag settings retain precedence', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  write(userFile, { enabledPlugins: { disk: true } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({
    projectPath,
    sources: [],
    flagSettings: { enabledPlugins: { flag: true } },
  });
  expect(settings.setValue('user', ['enabledPlugins', 'runtime'], true)).toBe(
    true,
  );
  expect(settings.merged.enabledPlugins).toEqual({ runtime: true, flag: true });
  expect(JSON.parse(readFileSync(userFile, 'utf8')).enabledPlugins).toEqual({
    disk: true,
  });
});

it('preserves the file and snapshot when a transaction encounters invalid JSON', () => {
  const errors: string[] = [];
  const { service, userConfigDir, userFile, projectPath } = fixture({
    onWriteError: (message) => errors.push(message),
  });
  write(userFile, { enabledPlugins: { original: true } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  writeFileSync(userFile, '{broken');
  expect(settings.setValue('user', ['enabledPlugins', 'new'], true)).toBe(
    false,
  );
  expect(readFileSync(userFile, 'utf8')).toBe('{broken');
  expect(settings.merged.enabledPlugins).toEqual({ original: true });
  expect(errors).toHaveLength(1);
});

it('preserves placeholders on disk and expands touched runtime fields', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture({
    environment: { TOKEN: 'secret' },
  });
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  expect(settings.setValue('user', 'custom', '${TOKEN}')).toBe(true);
  expect((settings.merged as Record<string, unknown>)['custom']).toBe('secret');
  expect(JSON.parse(readFileSync(userFile, 'utf8')).custom).toBe('${TOKEN}');
});

it('keeps originalSettings normalized after writes without rewriting legacy disk values', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  write(userFile, { model: 'old-model' });
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  expect(settings.user.originalSettings['model']).toEqual({
    name: 'old-model',
  });
  expect(settings.setValue('user', ['enabledPlugins', 'demo'], true)).toBe(
    true,
  );
  expect(settings.user.originalSettings['model']).toEqual({
    name: 'old-model',
  });
  expect(settings.user.settings['model']).toEqual({ name: 'old-model' });
  expect(JSON.parse(readFileSync(userFile, 'utf8')).model).toBe('old-model');
  expect(JSON.parse(settings.user.rawJson!).model).toBe('old-model');
});

it('refreshes shared user text even on no-op writes without changing existing snapshots', () => {
  const { service, userConfigDir, userFile, projectPath } = fixture();
  write(userFile, { enabledPlugins: { cached: true } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  write(userFile, { enabledPlugins: { external: true } });
  const disk = readFileSync(userFile, 'utf8');
  expect(settings.deleteValue('user', ['enabledPlugins', 'missing'])).toBe(
    true,
  );
  expect(readFileSync(userFile, 'utf8')).toBe(disk);
  expect(settings.user.settings.enabledPlugins).toEqual({ cached: true });
  expect(service.resolve({ projectPath }).user.settings.enabledPlugins).toEqual(
    { external: true },
  );
  expect(settings.setValue('user', ['enabledPlugins', 'written'], true)).toBe(
    true,
  );
  expect(service.resolve({ projectPath }).user.settings.enabledPlugins).toEqual(
    { external: true, written: true },
  );
});

it('updates trust and merged layers on revoke and grant without changing other snapshots', () => {
  const {
    service,
    userConfigDir,
    userFile,
    projectPath,
    projectFile,
    localFile,
  } = fixture({ headless: false });
  write(userFile, {
    security: { folderTrust: { enabled: true } },
    permissions: { trustDirectories: [projectPath] },
  });
  write(projectFile, { enabledPlugins: { project: true } });
  write(localFile, { enabledPlugins: { local: true } });
  service.initialize({ userConfigDir });
  const settings = service.resolve({
    projectPath,
    flagSettings: { enabledPlugins: { flag: true } },
  });
  const other = service.resolve({ projectPath });
  expect(settings.isTrusted).toBe(true);
  expect(settings.deleteValue('User', 'permissions.trustDirectories')).toBe(
    true,
  );
  expect(settings.isTrusted).toBe(false);
  expect(settings.merged.enabledPlugins).toEqual({ flag: true });
  expect(other.isTrusted).toBe(true);
  expect(other.merged.enabledPlugins).toEqual({ project: true, local: true });
  expect(settings.forScope('project').settings.enabledPlugins).toEqual({
    project: true,
  });
  expect(service.resolve({ projectPath }).isTrusted).toBe(false);
  expect(
    settings.setValue('user', 'permissions.trustDirectories', [projectPath]),
  ).toBe(true);
  expect(settings.isTrusted).toBe(true);
  expect(settings.merged.enabledPlugins).toEqual({
    project: true,
    local: true,
    flag: true,
  });
});

it.each([false, true])(
  'retains host headless trust policy after mutation: %s',
  (headless) => {
    const { service, userConfigDir, userFile, projectPath, projectFile } =
      fixture({ headless });
    write(userFile, { security: { folderTrust: { enabled: false } } });
    write(projectFile, {
      enabledPlugins: { project: true },
      permissions: { trustDirectories: [projectPath] },
    });
    service.initialize({ userConfigDir });
    const settings = service.resolve({
      projectPath,
      flagSettings: { permissions: { trustDirectories: [projectPath] } },
    });
    expect(settings.isTrusted).toBe(true);
    expect(
      settings.setValue('user', 'security.folderTrust.enabled', true),
    ).toBe(true);
    expect(settings.isTrusted).toBe(headless);
    expect(settings.merged.enabledPlugins).toEqual(
      headless ? { project: true } : {},
    );
  },
);

it('notifies the host only for successful disk changes across all scopes', () => {
  let persisted = 0;
  const { service, userConfigDir, userFile, projectPath, localFile } = fixture({
    onSettingsPersisted: () => {
      persisted++;
    },
  });
  write(userFile, {});
  service.initialize({ userConfigDir });
  const settings = service.resolve({ projectPath });
  for (const scope of ['user', 'project', 'local'] as const) {
    expect(settings.setValue(scope, ['enabledPlugins', 'demo'], true)).toBe(
      true,
    );
    expect(settings.setValue(scope, ['enabledPlugins', 'demo'], true)).toBe(
      true,
    );
  }
  expect(persisted).toBe(3);
  // A disk change must invalidate host caches even when the runtime value is unchanged.
  write(userFile, { enabledPlugins: { demo: false } });
  expect(settings.setValue('user', ['enabledPlugins', 'demo'], true)).toBe(
    true,
  );
  expect(persisted).toBe(4);
  const excluded = service.resolve({ projectPath, sources: [] });
  expect(excluded.setValue('user', ['enabledPlugins', 'memory'], true)).toBe(
    true,
  );
  writeFileSync(localFile, '{broken');
  expect(settings.setValue('local', ['enabledPlugins', 'fail'], true)).toBe(
    false,
  );
  expect(persisted).toBe(4);
});


it.each([true, false])(
  'accepts a retired directWebFetch setting without rewriting user settings (%s)',
  (value) => {
    const { service, userConfigDir, userFile, projectPath } = fixture();
    write(userFile, {
      experimental: { directWebFetch: value },
      model: { name: 'existing-model' },
    });
    const original = readFileSync(userFile, 'utf8');
    service.initialize({ userConfigDir });
    const settings = service.resolve({ projectPath });
    expect(settings.merged.model?.name).toBe('existing-model');
    expect(readFileSync(userFile, 'utf8')).toBe(original);
  },
);

it('uses per-read headless trust without trusting other projections or persisting it', async () => {
  const loadEnvironment = vi.fn();
  const { service, userConfigDir, projectPath, projectFile, userFile } =
    fixture({ headless: false, loadEnvironment });
  write(userFile, { security: { folderTrust: { enabled: true } } });
  write(projectFile, {
    projectOnly: 'loaded',
    hooks: { SessionStart: [] },
    mcpServers: { local: { command: 'local-tool' } },
  });
  service.initialize({ userConfigDir });
  try {
    const interactive = service.resolve({ projectPath });
    expect(loadEnvironment).toHaveBeenLastCalledWith(
      expect.anything(),
      projectPath,
      undefined,
    );
    service.resolve({ projectPath, headless: false });
    expect(loadEnvironment).toHaveBeenLastCalledWith(
      expect.anything(),
      projectPath,
      undefined,
    );
    const headless = service.resolve({ projectPath, headless: true });
    expect(interactive.isTrusted).toBe(false);
    expect(headless.isTrusted).toBe(true);
    expect(headless.merged).toMatchObject({
      projectOnly: 'loaded',
      mcpServers: { local: { command: 'local-tool' } },
    });
    expect(loadEnvironment).toHaveBeenLastCalledWith(
      expect.anything(),
      projectPath,
      true,
    );
    headless.reload();
    expect(headless.isTrusted).toBe(true);
    expect(service.resolve({ projectPath }).isTrusted).toBe(false);
    expect(interactive.isTrusted).toBe(false);
    expect(readFileSync(userFile, 'utf8')).not.toContain('trustDirectories');
  } finally {
    await service.dispose();
  }
});

it('can explicitly resolve interactive trust under a headless host', async () => {
  const { service, userConfigDir, projectPath, projectFile } = fixture({
    headless: true,
  });
  write(projectFile, { projectOnly: 'loaded' });
  service.initialize({ userConfigDir });
  try {
    expect(service.resolve({ projectPath, headless: false }).isTrusted).toBe(
      false,
    );
    expect(service.resolve({ projectPath }).isTrusted).toBe(true);
  } finally {
    await service.dispose();
  }
});

it('exposes managed policy settings without merging them into ordinary settings', () => {
  const { service, userConfigDir, root } = fixture();
  const policyPath = join(root, 'managed-settings.json');
  write(policyPath, {
    rules: [
      { subject: { kind: 'tool', toolName: 'Bash' }, behavior: 'deny' },
    ],
    allowManagedOnly: false,
  });
  service.initialize({ userConfigDir, policySettingsPath: policyPath });

  expect(service.getPolicySettings()?.value).toEqual({
    rules: [
      { subject: { kind: 'tool', toolName: 'Bash' }, behavior: 'deny' },
    ],
    allowManagedOnly: false,
  });
  expect(service.resolve({ projectPath: join(root, 'project') }).merged).not.toHaveProperty('rules');
});

it('treats a missing policy file as withdrawn, and rejects a changed policy path', () => {
  const { service, userConfigDir, root } = fixture();
  service.initialize({
    userConfigDir,
    policySettingsPath: join(root, 'managed-settings.json'),
  });
  expect(service.getPolicySettings()).toBeUndefined();

  expect(() =>
    service.initialize({
      userConfigDir,
      policySettingsPath: join(root, 'other-managed-settings.json'),
    }),
  ).toThrow('Settings directories are already fixed for this service');
});
